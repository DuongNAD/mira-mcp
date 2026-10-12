/**
 * The Python tracer. `mira_record` writes this script to a temp folder next to a params.json and runs
 * `python -B -X utf8 tracer.py params.json`; the script writes the trace JSON to params["out"].
 *
 * The script is kept as one raw string (no backticks and no dollar-brace sequences inside) so that it can be
 * emitted verbatim.
 */
export const TRACER_VERSION = 1;

export const TRACER_PY = String.raw`# -*- coding: utf-8 -*-
# Mira tracer (v1). Runs a Python file under sys.settrace and records every executed line of the focused functions
# together with the variables of the frame. Generated and executed by mira_record; do not edit by hand.
import sys
import os
import io
import re
import ast
import json
import time
import types
import itertools
import traceback
import collections
import enum
import threading
import importlib.util

sys.dont_write_bytecode = True
T0 = time.time()

with open(sys.argv[1], "r", encoding="utf-8") as _fh:
    P = json.load(_fh)


def _key(p):
    try:
        return os.path.normcase(os.path.realpath(p))
    except Exception:
        return os.path.normcase(os.path.abspath(p))


TARGET_FILE = P["file"]
TARGET_DIR = os.path.dirname(TARGET_FILE)
TARGET_KEY = _key(TARGET_FILE)
TRACER_KEY = _key(__file__)
CALL = P.get("call")
SCRIPT = bool(P.get("script"))
MAX_STEPS = int(P.get("max_steps") or 2000)
MAX_REPR = int(P.get("max_repr") or 120)
OUT_PATH = P["out"]
LAB = P.get("lab")
NAME = P.get("name")
TIMEOUT = float(P.get("timeout_sec") or 0)

CAP_TEXT = 20000
MAX_LIST = 200
MAX_DICT = 100
MAX_SET = 1000
MAX_DEPTH = 3
MAX_ATTRS = 30
MAX_VAR_CHARS = 60000
FAST_LIMIT = 5000
INT_LIMIT = 2 ** 53
INF = float("inf")

with open(TARGET_FILE, "r", encoding="utf-8-sig", errors="replace") as _fh:
    SOURCE_TEXT = _fh.read()
SOURCE_LINES = re.split(r"\r\n|\r|\n", SOURCE_TEXT)
if SOURCE_LINES and SOURCE_LINES[-1] == "":
    SOURCE_LINES.pop()


def _default_focus():
    names = set()
    try:
        tree = ast.parse(SOURCE_TEXT, TARGET_FILE)
    except SyntaxError:
        return names
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
    return names


USER_FOCUS = [str(x) for x in (P.get("focus") or [])]
if USER_FOCUS:
    FOCUS = set(USER_FOCUS)
else:
    FOCUS = _default_focus()
    if SCRIPT:
        FOCUS.add("<module>")

PROBE_ITEMS = []
PROBE_ERRORS = []
for _name, _expr in (P.get("probes") or {}).items():
    try:
        PROBE_ITEMS.append((str(_name), compile(str(_expr), "<probe:%s>" % _name, "eval")))
    except Exception as _e:
        PROBE_ERRORS.append("%s: %s" % (_name, _e))


# ---------------------------------------------------------------- output capture
class Capture(io.TextIOBase):
    def __init__(self):
        io.TextIOBase.__init__(self)
        self.parts = []
        self.n = 0

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        room = CAP_TEXT - self.n
        if room > 0:
            chunk = s[:room]
            self.parts.append(chunk)
            self.n += len(chunk)
        return len(s)

    def flush(self):
        pass

    def isatty(self):
        return False

    def writable(self):
        return True

    @property
    def encoding(self):
        return "utf-8"

    def text(self):
        return "".join(self.parts)


STDOUT = Capture()
STDERR = Capture()


# ---------------------------------------------------------------- serialization
_impure = [False]
_ADDR = re.compile(r" at 0x[0-9A-Fa-f]+")


def _short_repr(v, limit=None):
    limit = limit or MAX_REPR
    try:
        r = repr(v)
    except Exception:
        r = "<không hiển thị được>"
    r = _ADDR.sub("", r)
    if len(r) > limit:
        r = r[:limit] + "..."
    return r


def _cnum(x):
    if x != x:
        return "nan"
    if x == INF:
        return "inf"
    if x == -INF:
        return "-inf"
    return x


def _ser_float(v):
    if v != v:
        return {"__float__": "nan"}
    if v == INF:
        return {"__float__": "inf"}
    if v == -INF:
        return {"__float__": "-inf"}
    if v.is_integer():
        return {"__float__": repr(v)}
    return v


def _index_like(k):
    return k.isdigit() and (k == "0" or k[0] != "0") and len(k) <= 10


def _ser_seq(v, d):
    n = len(v)
    if n and d >= MAX_DEPTH:
        return {"__repr__": _short_repr(v)}
    if n > MAX_LIST:
        return {"__list__": [ser(x, d + 1) for x in itertools.islice(v, MAX_LIST)], "n": n}
    return [ser(x, d + 1) for x in v]


def _ser_tuple(v, d):
    n = len(v)
    if n and d >= MAX_DEPTH:
        return {"__repr__": _short_repr(v)}
    if n > MAX_LIST:
        return {"__tuple__": [ser(x, d + 1) for x in itertools.islice(v, MAX_LIST)], "n": n}
    return {"__tuple__": [ser(x, d + 1) for x in v]}


def _ser_dict(v, d):
    n = len(v)
    if n and d >= MAX_DEPTH:
        return {"__repr__": _short_repr(v)}
    items = list(itertools.islice(v.items(), MAX_DICT))
    plain = n <= MAX_DICT
    if plain:
        for k, _x in items:
            if type(k) is not str or k.startswith("__") or (k.isascii() and _index_like(k)):
                plain = False
                break
    if plain:
        return {k: ser(x, d + 1) for k, x in items}
    out = {"__dict__": [[ser(k, d + 1), ser(x, d + 1)] for k, x in items]}
    if n > MAX_DICT:
        out["n"] = n
    return out


def _ser_set(v, d, frozen):
    n = len(v)
    if n and d >= MAX_DEPTH:
        return {"__repr__": _short_repr(v)}
    try:
        elems = sorted(v)
    except Exception:
        elems = sorted(v, key=_short_repr)
    out = {"__set__": [ser(x, d + 1) for x in elems[:MAX_SET]]}
    if frozen:
        out["frozen"] = True
    if n > MAX_SET:
        out["n"] = n
    return out


def _nd_item(x):
    if isinstance(x, bool):
        return x
    if isinstance(x, int):
        return x if -INT_LIMIT <= x <= INT_LIMIT else str(x)
    if isinstance(x, float):
        return _cnum(x)
    if isinstance(x, complex):
        return [_cnum(x.real), _cnum(x.imag)]
    return _short_repr(x)


def _ser_ndarray(v):
    out = {"shape": [int(x) for x in v.shape], "dtype": str(v.dtype)}
    if int(v.size) <= 1024:
        out["data"] = [_nd_item(x) for x in v.reshape(-1).tolist()]
    return {"__ndarray__": out}


def _attrs_of(v):
    try:
        dct = vars(v)
    except TypeError:
        dct = None
    if dct is not None:
        return [(k, x) for k, x in list(dct.items()) if isinstance(k, str) and not k.startswith("__")]
    slots = []
    for c in type(v).__mro__:
        sl = c.__dict__.get("__slots__", ())
        if isinstance(sl, str):
            sl = (sl,)
        slots.extend(sl)
    if not slots:
        return None
    pairs = []
    for name in slots:
        if isinstance(name, str) and not name.startswith("__") and hasattr(v, name):
            pairs.append((name, getattr(v, name)))
    return pairs


def _ser_other(v, d):
    np = sys.modules.get("numpy")
    if np is not None:
        try:
            if isinstance(v, np.ndarray):
                return _ser_ndarray(v)
            if isinstance(v, np.generic):
                return ser(v.item(), d)
        except Exception:
            return {"__repr__": _short_repr(v)}
    if isinstance(v, enum.Enum):
        return {"__repr__": _short_repr(v)}
    if isinstance(v, bool):
        return bool(v)
    if isinstance(v, int):
        return ser(int(v), d)
    if isinstance(v, float):
        return _ser_float(float(v))
    if isinstance(v, str):
        return ser(str.__str__(v), d)
    if isinstance(v, (list, collections.deque)):
        return _ser_seq(v, d)
    if isinstance(v, tuple):
        if hasattr(v, "_fields"):
            if d >= MAX_DEPTH:
                return {"__repr__": _short_repr(v)}
            return {"__obj__": type(v).__name__, "attrs": {f: ser(x, d + 1) for f, x in zip(v._fields, v)}}
        return _ser_tuple(v, d)
    if isinstance(v, dict):
        return _ser_dict(v, d)
    if isinstance(v, (set, frozenset)):
        return _ser_set(v, d, isinstance(v, frozenset))
    if isinstance(v, complex):
        return {"__complex__": [_cnum(v.real), _cnum(v.imag)]}
    if isinstance(v, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType, type)):
        return {"__repr__": _short_repr(v)}
    if isinstance(v, (bytes, bytearray, range, memoryview)):
        return {"__repr__": _short_repr(v)}
    attrs = _attrs_of(v)
    if attrs is not None:
        if d >= MAX_DEPTH:
            return {"__repr__": _short_repr(v)}
        out = {}
        for k, x in itertools.islice(attrs, MAX_ATTRS):
            out[k] = ser(x, d + 1)
        return {"__obj__": type(v).__name__, "attrs": out}
    return {"__repr__": _short_repr(v)}


def ser(v, d):
    t = type(v)
    if t is int:
        if -INT_LIMIT <= v <= INT_LIMIT:
            return v
        return {"__int__": str(v)}
    if t is str:
        if len(v) > MAX_REPR:
            return {"__str__": v[:MAX_REPR], "n": len(v)}
        return v
    if t is bool or v is None:
        return v
    if t is float:
        return _ser_float(v)
    if t is list:
        return _ser_seq(v, d)
    if t is tuple:
        return _ser_tuple(v, d)
    if t is dict:
        return _ser_dict(v, d)
    if t is set:
        return _ser_set(v, d, False)
    if t is frozenset:
        return _ser_set(v, d, True)
    if t is complex:
        return {"__complex__": [_cnum(v.real), _cnum(v.imag)]}
    if t is collections.deque:
        return _ser_seq(v, d)
    _impure[0] = True
    return _ser_other(v, d)


def _json(x):
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def serialize_var(val):
    """Returns (json text, plain) where plain means: only builtin containers of builtin scalars."""
    _impure[0] = False
    try:
        s = _json(ser(val, 0))
    except Exception as e:
        s = _json({"__repr__": "<không ghi lại được: %s>" % type(e).__name__})
        _impure[0] = True
    if len(s) > MAX_VAR_CHARS:
        s = _json({"__repr__": _short_repr(val)})
        _impure[0] = True
    return s, not _impure[0]


PLAIN_CONTAINERS = (list, dict, set, frozenset, tuple, collections.deque)
SKIP_MODULE_VALUES = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)


def _type_name(val):
    return type(val).__name__


# ---------------------------------------------------------------- recording state
EVENTS = []
LINE_HITS = {}
LINE_COUNT = [0]
NEXT_FID = [0]
STACK = []
STOPPED = [False]
TRUNCATED = [False]
TRACER_ERRORS = []
CODE_OK = {}
FILE_OK = {}


class FrameInfo(object):
    __slots__ = ("fid", "func", "depth", "prev", "cache", "is_module", "pending_exc", "last_types", "fk", "exc_seen")

    def __init__(self, fid, func, depth, is_module):
        self.fid = fid
        self.func = func
        self.depth = depth
        self.prev = {}
        self.cache = {}
        self.is_module = is_module
        self.pending_exc = False
        self.last_types = {}
        self.fk = 0
        self.exc_seen = False


def capture_locals(frame, info, commit=True):
    prev = info.prev
    cache = info.cache
    cur = {}
    types_map = {}
    changed = []
    for name, val in list(frame.f_locals.items()):
        if name.startswith("__") or name.startswith("."):
            continue
        if info.is_module and isinstance(val, SKIP_MODULE_VALUES):
            continue
        t = type(val)
        s = None
        ent = cache.get(name)
        if ent is not None and ent[0] is t and t in PLAIN_CONTAINERS:
            try:
                if len(val) <= FAST_LIMIT and repr(val) == ent[1]:
                    s = ent[2]
            except Exception:
                s = None
        if s is None:
            s, plain = serialize_var(val)
            if commit:
                if plain and t in PLAIN_CONTAINERS and len(val) <= FAST_LIMIT:
                    try:
                        cache[name] = (t, repr(val), s)
                    except Exception:
                        cache.pop(name, None)
                else:
                    cache.pop(name, None)
        cur[name] = s
        types_map[name] = t.__name__
        if prev.get(name) != s:
            changed.append(name)
    gone = [n for n in prev if n not in cur]
    if types_map == info.last_types:
        types_map = info.last_types
    elif commit:
        info.last_types = types_map
    if commit:
        info.prev = cur
    return cur, changed, types_map, gone


def eval_probes(frame):
    out = {}
    for name, code in PROBE_ITEMS:
        try:
            val = eval(code, frame.f_globals, frame.f_locals)
            s, _plain = serialize_var(val)
        except Exception:
            s = "null"
        out[name] = s
    return out


def _stop_tracing(frame):
    STOPPED[0] = True
    sys.settrace(None)
    f = frame
    while f is not None:
        try:
            f.f_trace = None
        except Exception:
            pass
        f = f.f_back


def on_call(frame, code):
    fid = NEXT_FID[0] + 1
    NEXT_FID[0] = fid
    is_module = code.co_name == "<module>"
    info = FrameInfo(fid, code.co_name, len(STACK) + 1, is_module)
    info.fk = id(frame)
    STACK.append(info)
    cur, _changed, types_map, _gone = capture_locals(frame, info, commit=False)
    EVENTS.append({
        "i": len(EVENTS), "ev": "call", "func": info.func, "line": code.co_firstlineno, "depth": info.depth,
        "fid": fid, "args": cur, "types": types_map, "out": STDOUT.n,
    })
    return info


def on_line(frame, info):
    if LINE_COUNT[0] >= MAX_STEPS:
        TRUNCATED[0] = True
        _stop_tracing(frame)
        write_trace(final=False)
        return
    LINE_COUNT[0] += 1
    lineno = frame.f_lineno
    info.pending_exc = False
    cur, changed, types_map, gone = capture_locals(frame, info)
    ev = {
        "i": len(EVENTS), "ev": "line", "line": lineno, "func": info.func, "depth": info.depth, "fid": info.fid,
        "chg": {n: cur[n] for n in changed}, "gone": gone, "changed": changed, "types": types_map,
        "out": STDOUT.n,
    }
    if PROBE_ITEMS:
        ev["probes"] = eval_probes(frame)
    EVENTS.append(ev)
    LINE_HITS[lineno] = LINE_HITS.get(lineno, 0) + 1


def on_return(frame, info, arg):
    unwound = info.pending_exc
    if unwound:
        s = "null"
        tname = "NoneType"
    else:
        s, _plain = serialize_var(arg)
        tname = _type_name(arg)
    ev = {
        "i": len(EVENTS), "ev": "return", "func": info.func, "line": frame.f_lineno, "depth": info.depth,
        "fid": info.fid, "value": s, "type": tname, "out": STDOUT.n, "fk": info.fk, "exc": info.exc_seen,
    }
    if unwound:
        ev["unwound"] = True
    EVENTS.append(ev)
    if STACK and STACK[-1] is info:
        STACK.pop()
    elif info in STACK:
        STACK.remove(info)


def on_exception(frame, info, arg):
    etype, evalue, _tb = arg
    if etype is StopIteration or etype is GeneratorExit:
        return
    info.pending_exc = True
    info.exc_seen = True
    try:
        msg = str(evalue)
    except Exception:
        msg = ""
    EVENTS.append({
        "i": len(EVENTS), "ev": "exception", "func": info.func, "line": frame.f_lineno, "depth": info.depth,
        "fid": info.fid, "type": etype.__name__, "message": msg[:300], "out": STDOUT.n,
    })


def make_local(info):
    def local(frame, event, arg):
        if STOPPED[0]:
            return None
        try:
            if event == "line":
                on_line(frame, info)
            elif event == "return":
                on_return(frame, info, arg)
            elif event == "exception":
                on_exception(frame, info, arg)
        except Exception as e:
            TRACER_ERRORS.append("%s: %s" % (type(e).__name__, e))
            _stop_tracing(frame)
            return None
        return None if STOPPED[0] else local

    return local


def _file_ok(filename):
    ok = FILE_OK.get(filename)
    if ok is None:
        ok = _key(filename) == TARGET_KEY
        FILE_OK[filename] = ok
    return ok


def global_trace(frame, event, arg):
    if event != "call" or STOPPED[0]:
        return None
    code = frame.f_code
    ok = CODE_OK.get(code)
    if ok is None:
        ok = code.co_name in FOCUS and _file_ok(code.co_filename)
        CODE_OK[code] = ok
    if not ok:
        return None
    try:
        info = on_call(frame, code)
    except Exception as e:
        TRACER_ERRORS.append("%s: %s" % (type(e).__name__, e))
        _stop_tracing(frame)
        return None
    return make_local(info)


# ---------------------------------------------------------------- writing
def _build_events_json():
    parts = []
    carried = {}
    for ev in list(EVENTS):
        kind = ev["ev"]
        head = '{"i":%d,"ev":"%s","line":%d,"func":%s,"depth":%d,"fid":%d' % (
            ev["i"], kind, ev["line"], _json(ev["func"]), ev["depth"], ev["fid"])
        if kind == "line":
            loc = carried.setdefault(ev["fid"], {})
            for g in ev["gone"]:
                loc.pop(g, None)
            loc.update(ev["chg"])
            body = ',"locals":{%s},"types":%s,"changed":%s' % (
                ",".join(_json(k) + ":" + v for k, v in loc.items()), _json(ev["types"]), _json(ev["changed"]))
            if "probes" in ev:
                body += ',"probes":{%s}' % ",".join(_json(k) + ":" + v for k, v in ev["probes"].items())
        elif kind == "call":
            body = ',"args":{%s},"types":%s' % (
                ",".join(_json(k) + ":" + v for k, v in ev["args"].items()), _json(ev["types"]))
        elif kind == "return":
            body = ',"value":%s,"type":%s' % (ev["value"], _json(ev["type"]))
            if ev.get("unwound"):
                body += ',"unwound":true'
            carried.pop(ev["fid"], None)
        else:
            body = ',"type":%s,"message":%s' % (_json(ev["type"]), _json(ev["message"]))
        parts.append(head + body + ',"out":%d}' % ev["out"])
    return parts


RESULT = {}
ERROR = {}
WRITE_LOCK = threading.Lock()
FINISHED = [False]


def write_trace(final, watchdog=False):
    with WRITE_LOCK:
        if watchdog and FINISHED[0]:
            return
        if final:
            FINISHED[0] = True
        _write_trace(final)


def _watchdog():
    # Snapshot the partial trace shortly before the parent kills a run that is too slow or loops forever.
    time.sleep(max(0.4, TIMEOUT - 0.9))
    for _attempt in range(3):
        try:
            write_trace(final=False, watchdog=True)
            return
        except Exception:
            time.sleep(0.05)


def _write_trace(final):
    doc = {
        "v": 1,
        "tool": "mira",
        "file": TARGET_FILE,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        "python": sys.version.split()[0],
        "focus": sorted(FOCUS),
        "truncated": TRUNCATED[0],
        "stdout": STDOUT.text(),
        "stderr": STDERR.text(),
        "lines": {str(k): v for k, v in sorted(list(LINE_HITS.items()))},
        "source": SOURCE_LINES,
        "stats": {"events": len(EVENTS), "lineEvents": LINE_COUNT[0], "elapsedMs": int((time.time() - T0) * 1000)},
    }
    if CALL:
        doc["call"] = CALL
    if SCRIPT:
        doc["script"] = True
    if LAB:
        doc["lab"] = LAB
    if NAME:
        doc["name"] = NAME
    if PROBE_ITEMS:
        doc["probes"] = [n for n, _c in PROBE_ITEMS]
    if PROBE_ERRORS:
        doc["probeErrors"] = PROBE_ERRORS
    if TRACER_ERRORS:
        doc["tracerError"] = TRACER_ERRORS[0]
    if not final:
        doc["incomplete"] = True
    if RESULT:
        doc["result"] = RESULT["repr"]
        doc["resultValue"] = json.loads(RESULT["json"])
    if ERROR:
        doc["error"] = ERROR
    text = _json(doc)
    text = text[:-1] + ',"steps":[' + ",".join(_build_events_json()) + "]}"
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8", errors="replace", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, OUT_PATH)


# ---------------------------------------------------------------- running
def describe_error(e):
    tb = e.__traceback__
    entries = traceback.extract_tb(tb)
    line = None
    keep = []
    for fs in entries:
        k = _key(fs.filename) if fs.filename and not fs.filename.startswith("<") else fs.filename
        if k == TARGET_KEY and fs.lineno:
            line = fs.lineno
        if k == TRACER_KEY or fs.filename == "<mira-call>":
            continue
        keep.append(fs)
    if isinstance(e, SyntaxError) and e.lineno:
        line = e.lineno
    text = ""
    if keep:
        text = "Traceback (most recent call last):\n" + "".join(traceback.format_list(keep))
    text += "".join(traceback.format_exception_only(type(e), e))
    out = {"type": type(e).__name__, "message": str(e)[:2000], "traceback": text[-6000:]}
    if line:
        out["line"] = line
    return out


def mark_unwound(e):
    """Returns that happened while the final uncaught exception was propagating (e.g. after a finally block)."""
    ids = set()
    tb = e.__traceback__
    while tb is not None:
        ids.add(id(tb.tb_frame))
        tb = tb.tb_next
    for ev in EVENTS:
        if ev["ev"] == "return" and ev.get("exc") and ev.get("fk") in ids and ev["value"] == "null":
            ev["unwound"] = True


def run():
    if TIMEOUT > 2.0:
        threading.Thread(target=_watchdog, daemon=True).start()
    sys.path.insert(0, TARGET_DIR)
    stdin_text = P.get("stdin")
    sys.stdin = io.StringIO(stdin_text if isinstance(stdin_text, str) else "")
    real_out, real_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = STDOUT, STDERR
    value = None
    have_value = False
    try:
        if SCRIPT:
            code = compile(SOURCE_TEXT, TARGET_FILE, "exec")
            mod = types.ModuleType("__main__")
            mod.__file__ = TARGET_FILE
            sys.modules["__main__"] = mod
            sys.argv = [TARGET_FILE]
            sys.settrace(global_trace)
            try:
                exec(code, mod.__dict__)
            finally:
                sys.settrace(None)
        else:
            modname = "mira_target_" + re.sub(r"\W", "_", os.path.splitext(os.path.basename(TARGET_FILE))[0])
            spec = importlib.util.spec_from_file_location(modname, TARGET_FILE)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[modname] = mod
            spec.loader.exec_module(mod)
            expr = compile(CALL, "<mira-call>", "eval")
            sys.settrace(global_trace)
            try:
                value = eval(expr, mod.__dict__)
                have_value = True
            finally:
                sys.settrace(None)
    except SystemExit as e:
        code = e.code
        if code not in (None, 0):
            ERROR.update({"type": "SystemExit", "message": "exit code %s" % (code,), "traceback": ""})
    except BaseException as e:
        ERROR.update(describe_error(e))
        mark_unwound(e)
    finally:
        sys.settrace(None)
        sys.stdout, sys.stderr = real_out, real_err
    if have_value:
        try:
            RESULT["repr"] = _short_repr(value, 2000)
            RESULT["json"] = serialize_var(value)[0]
        except Exception:
            RESULT["repr"] = "<không hiển thị được>"
            RESULT["json"] = "null"
    write_trace(final=True)


try:
    run()
except BaseException as _e:
    sys.stderr.write("mira tracer failed: %s: %s\n" % (type(_e).__name__, _e))
    traceback.print_exc()
    sys.exit(3)
`;
