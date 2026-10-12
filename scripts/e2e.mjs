#!/usr/bin/env node
/**
 * End-to-end test for Mira MCP over real MCP stdio, the CLI, the preview server, and the bundled player executed
 * against a fake DOM. A fake DOM cannot judge layout, so a few layout checks also run in a real headless Chrome
 * with device emulation (scripts/shots.mjs); they are skipped with a note when Chrome or Edge is not installed
 * (MIRA_CHROME sets the path, MIRA_E2E_NO_BROWSER=1 skips them on purpose).
 *
 * All fixtures and outputs live under %TEMP%. Nothing is written under D:/02_Learning_Knowledge: the optional
 * check against the learner's real file only READS it and sends all output to %TEMP%.
 *
 *   node scripts/e2e.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FakeEvent, bootPlayer } from "./fakedom.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base =
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "aurora-slides")
    : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "aurora-slides");
const TOOL = resolve(
  process.env.MIRA_TOOLCHAIN ?? process.env.ORION_TOOLCHAIN ?? process.env.VEGA_TOOLCHAIN ?? process.env.POLARIS_TOOLCHAIN ?? join(base, "toolchain"),
);
const req = createRequire(join(TOOL, "package.json"));
const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = req("@modelcontextprotocol/sdk/client/stdio.js");

const DIST = join(ROOT, "dist", "mira.mjs");
const TEST_DIR = join(tmpdir(), `mira_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
const FX = join(TEST_DIR, "fx");
const HUB = join(TEST_DIR, "hub");
rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(FX, { recursive: true });
mkdirSync(HUB, { recursive: true });

// Hooks and hubs must never touch real data during tests.
process.env.MIRA_SMARTDRIVE = "off";
process.env.MIRA_HUB = HUB;
process.env.POLARIS_HUB = HUB;

const lib = await import(pathToFileURL(DIST).href);

let failed = 0;
let passed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) passed++;
  else failed++;
  const d = String(detail).replace(/\s*[\r\n]+\s*/g, " | ");
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${d ? `  (${d})` : ""}`);
};
const section = (t) => console.log(`\n--- ${t} ---`);
const textOf = (r) =>
  (r.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
const pathAfter = (txt, label) => {
  const m = new RegExp(`${label}\\s*(.+)`).exec(txt);
  return m ? m[1].trim() : "";
};
const noExternalUrls = (html) => {
  const urls = html.match(/https?:\/\/[^\s"'<>)\\]+/gi) ?? [];
  return urls.filter((u) => u !== "http://www.w3.org/2000/svg");
};
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

const py = (() => {
  const cands = process.env.MIRA_PYTHON ? [[process.env.MIRA_PYTHON, []]] : [["python", []], ["py", ["-3"]]];
  for (const [c, a] of cands) {
    const r = spawnSync(c, [...a, "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
    if (r.status === 0 && String(r.stdout).trim() === "3") return { cmd: c, args: a };
  }
  return null;
})();
const hasNumpy = py ? spawnSync(py.cmd, [...py.args, "-B", "-c", "import numpy"], { encoding: "utf8" }).status === 0 : false;

console.log(`\n=== Running Mira MCP E2E Tests in ${TEST_DIR} ===`);
console.log(`python: ${py ? `${py.cmd} ${py.args.join(" ")}` : "NOT FOUND"}, numpy: ${hasNumpy ? "yes" : "no"}`);

/* ───────── fixtures (generic toy code, not the learner's exercises) ───────── */

writeFileSync(
  join(FX, "toy.py"),
  `def triangular(n):
    total = 0
    for k in range(1, n + 1):
        total += k
    return total


def helper(x):
    return x * 2


def with_helper(x):
    y = helper(x)
    return y + 1


def boom(i):
    data = [1, 2, 3]
    return data[i]


def forever():
    i = 0
    while True:
        i += 1


def chatty():
    print("xin chao")
    print("bye")
    return 1


def numerics():
    z = 1 + 2j
    big = 2 ** 70
    flt = 3.0
    inf = float("inf")
    pair = (1, 2)
    tags = {3, 1, 2}
    mixed = {"a": 1, 2: "b"}
    return z
${hasNumpy ? `

def with_numpy():
    import numpy as np
    arr = np.array([1.0, 2.5])
    comp = np.array([1 + 1j, 0j])
    mat = np.array([[1, 2], [3, 4]])
    return arr
` : ""}
`,
  "utf8",
);
writeFileSync(
  join(FX, "scaler.py"),
  `def scale_all(values, k):
    """Multiply every item by k. scale_all([1, 2, 3], 2) -> [2, 4, 6]"""
    out = []
    for v in values:
        out.append(v * k)
    return out


def no_example(x):
    """Return x unchanged."""
    return x


def broken(x):
    """Still has a blank. broken(1) -> 2"""
    return ___1___ + x
`,
  "utf8",
);
writeFileSync(
  join(FX, "shapes.py"),
  `import heapq
from collections import deque


def data_shapes():
    arr = [5, 3, 8, 1]
    i = 0
    losses = []
    for step in range(4):
        losses.append(10 / (step + 1))
        i = step
    table = {"a": 1, "b": 2}
    state = [0.5 + 0j, 0.5 + 0j, 0.5 + 0j, 0.5 + 0j]
    graph = {0: [1, 2], 1: [0], 2: [0]}
    seen = set()
    for node in [0, 1, 2]:
        seen.add(node)
    stack = [1]
    stack.append(2)
    queue = deque([1])
    queue.append(2)
    heap = []
    heapq.heappush(heap, 3)
    heapq.heappush(heap, 1)
    return len(arr)
`,
  "utf8",
);

const hookLog = join(TEST_DIR, "hook.log");
writeFileSync(join(TEST_DIR, "fakehook.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], process.argv.slice(3).join(" ") + "\\n");\n`, "utf8");

/* ───────── MCP client ───────── */

const client = new Client({ name: "mira-e2e", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [DIST],
  stderr: "inherit",
  env: { ...process.env, MIRA_SMARTDRIVE: "off", MIRA_HUB: HUB, POLARIS_HUB: HUB },
});
await client.connect(transport);
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });

const smokeEvents = []; // events produced by the fake-DOM player runs (validated against the contract at the end)

try {
  /* ───────── 1. server identity ───────── */
  section("server");
  const info = client.getServerVersion();
  ok("server identifies itself as mira 0.1.0", info?.name === "mira" && info?.version === "0.1.0", `${info?.name} ${info?.version}`);
  const instructions = client.getInstructions() ?? "";
  ok(
    "instructions include Workflow, Rules, Done when",
    instructions.includes("Workflow:") && instructions.includes("Rules:") && instructions.includes("Done when:") && instructions.includes("Never write the learner's solutions"),
  );
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expectedTools = ["mira_build", "mira_check", "mira_demo", "mira_drill", "mira_guide", "mira_preview", "mira_progress", "mira_record"];
  ok("exactly 8 tools registered", names.length === 8 && expectedTools.every((n) => names.includes(n)), names.join(", "));
  for (const topic of ["overview", "record", "build", "viz", "stops", "drill", "progress", "rules", "embed"]) {
    const r = await call("mira_guide", { topic });
    ok(`guide topic ${topic} is non-empty Vietnamese`, !r.isError && textOf(r).length > 400 && /[ăâêôơưđ]/i.test(textOf(r)));
  }
  let r = await call("mira_guide");
  ok("guide without topic lists topics", !r.isError && textOf(r).includes("`stops`") && textOf(r).includes("`embed`"));
  r = await call("mira_guide", { topic: "nope" }).catch((e) => ({ isError: true, content: [{ type: "text", text: String(e) }] }));
  ok("guide rejects unknown topic", Boolean(r.isError));

  if (!py) {
    ok("python 3 available", false, "install Python 3 or set MIRA_PYTHON");
    throw new Error("python missing");
  }

  /* ───────── 2. record ───────── */
  section("record");
  const toy = join(FX, "toy.py");
  const rec = await lib.recordTrace({ file: toy, call: "triangular(5)", out_dir: join(TEST_DIR, "o_tri"), probes: { sq: "total*total", bad: "nope_undefined" } });
  const tr = rec.trace;
  const lines = tr.steps.filter((s) => s.ev === "line");
  ok("record ok, result 15", rec.ok && tr.result === "15" && tr.resultValue === 15, tr.result);
  ok("13 line events for triangular(5)", lines.length === 13, String(lines.length));
  ok("line hit counts", tr.lines["2"] === 1 && tr.lines["3"] === 6 && tr.lines["4"] === 5 && tr.lines["5"] === 1, JSON.stringify(tr.lines));
  ok("line numbers are the line about to run", lines[0].line === 2 && lines[1].line === 3 && lines[2].line === 4);
  const firstAdd = lines.find((s) => s.line === 4);
  ok("locals are the state before the line runs", firstAdd.locals.total === 0 && firstAdd.locals.k === 1, JSON.stringify(firstAdd.locals));
  ok("changed flags: new name k at first add", JSON.stringify(firstAdd.changed) === JSON.stringify(["k"]));
  const secondFor = lines.filter((s) => s.line === 3)[1];
  ok("changed flags: total changed after += k", JSON.stringify(secondFor.changed) === JSON.stringify(["total"]), JSON.stringify(secondFor.changed));
  const ret = tr.steps.find((s) => s.ev === "return");
  ok("return event carries the value", ret && ret.value === 15 && ret.func === "triangular" && ret.line === 5);
  const calls = tr.steps.filter((s) => s.ev === "call");
  ok("call event with args", calls.length === 1 && calls[0].args.n === 5 && calls[0].func === "triangular");
  ok("probes evaluated, errors give null", lines[0].probes.sq === null && lines[2].probes.sq === 0 && lines[3].probes.sq === 1 && lines[5].probes.sq === 9 && lines[2].probes.bad === null, JSON.stringify(lines[5].probes));
  ok("source lines and python version stored", tr.source[0] === "def triangular(n):" && /^3\.\d+/.test(tr.python));
  ok("types map is stored for display", lines[3].types.total === "int" && lines[3].types.k === "int");
  ok("summary suggests stops", rec.summary.suggestedStops.length >= 2, String(rec.summary.suggestedStops.length));

  const t1 = JSON.parse(readFileSync(join(TEST_DIR, "o_tri", "trace.json"), "utf8"));
  ok("trace.json written under out_dir", t1.v === 1 && t1.tool === "mira");

  // via real MCP stdio
  r = await call("mira_record", { file: toy, call: "triangular(5)", out_dir: join(TEST_DIR, "o_tri_mcp") });
  ok("mira_record over MCP reports the result", !r.isError && textOf(r).includes("Kết quả: 15") && textOf(r).includes("Gợi ý điểm dừng"), textOf(r).split("\n")[0]);
  r = await call("mira_record", { file: toy, call: "triangular(5)", script: true, out_dir: join(TEST_DIR, "o_x") });
  ok("call and script together are refused", Boolean(r.isError) && textOf(r).includes("đúng một"));
  r = await call("mira_record", { file: toy, out_dir: join(TEST_DIR, "o_x") });
  ok("neither call nor script is refused", Boolean(r.isError));

  r = await call("mira_record", { file: toy, call: "triangular(3)", focus: ["not a name"], out_dir: join(TEST_DIR, "o_x") });
  ok("record validates focus names inside the handler (clear message)", Boolean(r.isError) && textOf(r).includes("focus[0]"), textOf(r).slice(0, 120));
  const strictRec = await lib.recordTrace({ file: toy, call: "triangular(3)", bogus: 1, out_dir: join(TEST_DIR, "o_x") });
  ok("recordTrace rejects unknown parameters with a hint", strictRec.ok === false && /bogus/.test(strictRec.text), strictRec.text.slice(0, 100));
  const advertised = JSON.stringify(tools);
  ok("advertised tool schemas have no regex patterns or refs (client-validator friendly)", !advertised.includes('"pattern"') && !advertised.includes("$ref"));

  const trunc = await lib.recordTrace({ file: toy, call: "triangular(100)", max_steps: 10, out_dir: join(TEST_DIR, "o_trunc") });
  ok("max_steps truncates but the program finishes", trunc.trace.truncated && trunc.trace.steps.filter((s) => s.ev === "line").length === 10 && trunc.trace.result === "5050");

  const t0 = Date.now();
  const loop = await call("mira_record", { file: toy, call: "forever()", timeout_sec: 2, max_steps: 100, out_dir: join(TEST_DIR, "o_loop") });
  const elapsed = (Date.now() - t0) / 1000;
  ok("infinite loop killed by the timeout with a clear error", Boolean(loop.isError) && textOf(loop).includes("hết thời gian") && elapsed < 9, `${elapsed.toFixed(1)}s`);
  const partial = existsSync(join(TEST_DIR, "o_loop", "trace.json")) ? JSON.parse(readFileSync(join(TEST_DIR, "o_loop", "trace.json"), "utf8")) : null;
  ok("partial trace of the loop is saved with a TimeoutError", partial && partial.error?.type === "TimeoutError" && partial.steps.length > 50 && partial.timedOut === true);

  // a loop inside an untraced helper never reaches max_steps: only the watchdog snapshot can save the partial trace
  writeFileSync(join(FX, "stuck.py"), "def stuck_helper():\n    t = 0\n    while True:\n        t += 1\n\n\ndef main():\n    a = 1\n    b = 2\n    stuck_helper()\n    return a + b\n", "utf8");
  const stuck = await lib.recordTrace({ file: join(FX, "stuck.py"), call: "main()", focus: ["main"], timeout_sec: 4, out_dir: join(TEST_DIR, "o_stuck") });
  ok(
    "a slow program that never hits max_steps still leaves a partial trace (watchdog)",
    stuck.timedOut && stuck.trace?.incomplete === true && stuck.trace.steps.filter((s) => s.ev === "line").length === 3 && stuck.trace.error?.type === "TimeoutError" && stuck.trace.steps.filter((s) => s.ev === "line").pop().line === 10,
    `${stuck.trace?.steps.length} events`,
  );

  const boom = await lib.recordTrace({ file: toy, call: "boom(7)", out_dir: join(TEST_DIR, "o_boom") });
  const exc = boom.trace.steps.find((s) => s.ev === "exception");
  ok("exception captured with type, message and line", boom.trace.error?.type === "IndexError" && boom.trace.error.line === 19 && exc?.type === "IndexError" && exc.line === 19, JSON.stringify(boom.trace.error)?.slice(0, 120));
  const unwound = boom.trace.steps.find((s) => s.ev === "return");
  ok("return event marks the exception unwinding", unwound?.unwound === true);

  const f1 = await lib.recordTrace({ file: toy, call: "with_helper(3)", out_dir: join(TEST_DIR, "o_f1") });
  const f2 = await lib.recordTrace({ file: toy, call: "with_helper(3)", focus: ["with_helper"], out_dir: join(TEST_DIR, "o_f2") });
  ok("default focus traces every function in the file", f1.trace.steps.some((s) => s.func === "helper"));
  ok("focus filtering ignores a helper not in focus", !f2.trace.steps.some((s) => s.func === "helper") && f2.trace.result === "7");

  const chat = await lib.recordTrace({ file: toy, call: "chatty()", out_dir: join(TEST_DIR, "o_chat") });
  const outs = chat.trace.steps.map((s) => s.out);
  ok("stdout captured and offsets are monotonic", chat.trace.stdout === "xin chao\nbye\n" && outs.every((v, i) => i === 0 || v >= outs[i - 1]) && outs[outs.length - 1] >= 9, JSON.stringify(chat.trace.stdout));

  const nums = await lib.recordTrace({ file: toy, call: "numerics()", out_dir: join(TEST_DIR, "o_num") });
  const lastNum = nums.trace.steps.filter((s) => s.ev === "line").pop();
  ok(
    "serialization: complex, bigint, tagged floats, tuple, set, non-str dict keys",
    JSON.stringify(lastNum.locals.z) === JSON.stringify({ __complex__: [1, 2] }) &&
      lastNum.locals.big.__int__ === String(2n ** 70n) &&
      lastNum.locals.flt.__float__ === "3.0" &&
      lastNum.locals.inf.__float__ === "inf" &&
      JSON.stringify(lastNum.locals.pair) === JSON.stringify({ __tuple__: [1, 2] }) &&
      JSON.stringify(lastNum.locals.tags) === JSON.stringify({ __set__: [1, 2, 3] }) &&
      JSON.stringify(lastNum.locals.mixed) === JSON.stringify({ __dict__: [["a", 1], [2, "b"]] }),
    JSON.stringify(lastNum.locals).slice(0, 200),
  );
  if (hasNumpy) {
    const np = await lib.recordTrace({ file: toy, call: "with_numpy()", out_dir: join(TEST_DIR, "o_np") });
    const last = np.trace.steps.filter((s) => s.ev === "line").pop();
    ok(
      "numpy ndarray serialization (real and complex)",
      last.locals.arr.__ndarray__.dtype === "float64" && JSON.stringify(last.locals.arr.__ndarray__.data) === "[1,2.5]" && last.locals.comp.__ndarray__.dtype === "complex128" && JSON.stringify(last.locals.comp.__ndarray__.data) === "[[1,1],[0,0]]",
      JSON.stringify(last.locals.comp),
    );
    const npb = await lib.buildPlayer({
      title: "Mảng numpy",
      trace: np.tracePath,
      out_dir: join(TEST_DIR, "o_np_player"),
      viz: [{ kind: "table", var: "mat" }, { kind: "statevector", var: "comp" }, { kind: "array", var: "arr" }],
    });
    ok("numpy arrays can be bound to table, statevector and array viz", npb.ok, npb.errors.join("; "));
    const npp = bootPlayer(readFileSync(npb.indexPath, "utf8"));
    for (let i = 0; i < 6; i++) npp.click(npp.byAria("Bước kế tiếp"));
    const tableCells = npp.byClass("tbl-wrap")[0]?.querySelectorAll("td").map((td) => td.textContent) ?? [];
    ok("a 2-D numpy array renders as a matrix table", npp.errors.length === 0 && ["1", "2", "3", "4"].every((x) => tableCells.includes(x)), tableCells.join(","));
    npp.click(npp.byClass("tab")[1]);
    ok("a complex numpy array renders as statevector rows", npp.errors.length === 0 && npp.byClass("sv-row").length === 2 && npp.byClass("sv-lab")[0].textContent === "|0>", String(npp.byClass("sv-row").length));
  } else {
    console.log("skip numpy ndarray serialization: numpy is not importable in this Python");
  }

  const det1 = await lib.recordTrace({ file: toy, call: "triangular(7)", out_dir: join(TEST_DIR, "o_d1") });
  const det2 = await lib.recordTrace({ file: toy, call: "triangular(7)", out_dir: join(TEST_DIR, "o_d2") });
  const strip = (t) => JSON.stringify({ ...t, created: 0, stats: 0 });
  ok("recording is deterministic", strip(det1.trace) === strip(det2.trace));
  ok("no __pycache__ created in the fixture folder", !existsSync(join(FX, "__pycache__")) && readdirSync(FX).every((n) => n.endsWith(".py")), readdirSync(FX).join(","));

  /* ───────── 3. compare.ts ───────── */
  section("compare");
  const cmp = (typed, expected, tol) => lib.comparePrediction(typed, expected, tol).right;
  ok("3 vs 3.0", cmp("3", 3) && cmp("3.0", 3) && cmp("3", { __float__: "3.0" }));
  ok("list vs tuple", cmp("[1, 2]", { __tuple__: [1, 2] }) && cmp("(1, 2)", [1, 2]) && cmp("1, 2", [1, 2]) && !cmp("[1, 3]", [1, 2]));
  ok("strings: quoted and bare", cmp("'abc'", "abc") && cmp("abc", "abc") && cmp('"abc"', "abc") && cmp("  abc  ", "abc") && !cmp("abd", "abc"));
  ok("expected string accepts a bare number text", cmp("3", "3"));
  ok("None / True / False", cmp("None", null) && cmp("True", true) && cmp("False", false) && !cmp("0", false) && !cmp("1", true) && cmp("true", true));
  ok("dict equality ignores order", cmp("{'a': 1, 'b': 2}", { b: 2, a: 1 }) && !cmp("{'a': 1}", { a: 2 }) && cmp("{1: 'x'}", { __dict__: [[1, "x"]] }));
  ok("set equality ignores order", cmp("{3, 1, 2}", { __set__: [1, 2, 3] }) && cmp("set()", { __set__: [] }) && !cmp("{1, 2}", { __set__: [1, 2, 3] }));
  ok("tolerance (default 1e-9 relative)", cmp("0.30000000000000004", 0.3) && !cmp("0.31", 0.3) && cmp("0.31", 0.3, 0.05) && cmp("1e-3", 0.001));
  ok("inf and nan", cmp("inf", { __float__: "inf" }) && cmp("float('nan')", { __float__: "nan" }) && cmp("-inf", { __float__: "-inf" }));
  ok("negative numbers and nested", cmp("-4", -4) && cmp("[[1, 2], [3]]", [[1, 2], [3]]) && cmp("(1, (2, 3))", { __tuple__: [1, { __tuple__: [2, 3] }] }));
  ok("complex", cmp("(1+2j)", { __complex__: [1, 2] }) && cmp("1+2j", { __complex__: [1, 2] }) && !cmp("1+3j", { __complex__: [1, 2] }));
  ok("bigint", cmp(String(2n ** 70n), { __int__: String(2n ** 70n) }));
  ok("garbage input is simply different", !cmp("[1, 2", [1, 2]) && !cmp("", 3));

  /* ───────── 3b. highlighter ───────── */
  section("highlight");
  const unesc = (h) => h.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const tricky = [
    "@decorator(arg)",
    "def f(a, b=1_000, *args, **kw):  # comment with 'quotes' and \"more\"",
    '    """Docstring line 1',
    "    still inside <b>docstring</b> & more",
    '    end"""',
    "    x = f'{a!r} \\'quoted\\' {b}' + rb'raw\\d' + \"tab\\t\"",
    "    y = 0x1F + 1e-3 + 0.5j + .25 + 3_0",
    "    z = a if a else lambda q: q ** 2 // 3 != 4",
    "    tên_hàm = [i for i in range(3)]  # unicode name",
    "class Foo(Base):",
    "    pass",
    "s = 'unterminated",
    "t = 1",
  ];
  const hl = lib.highlightSource(tricky);
  ok("highlighter preserves every source line exactly (tricky sample)", hl.html.every((h, i) => unesc(h) === tricky[i]), hl.html.map((h, i) => (unesc(h) === tricky[i] ? "" : `line ${i + 1}`)).filter(Boolean).join(","));
  ok("highlighter classifies keyword, def name, builtin, string, number, comment, decorator", /<span class="k">def<\/span> <span class="d">f<\/span>/.test(hl.html[1]) && /<span class="b">range<\/span>/.test(hl.html[8]) && /<span class="s">/.test(hl.html[5]) && /<span class="n">0x1F<\/span>/.test(hl.html[6]) && /<span class="c"># comment/.test(hl.html[1]) && /<span class="a">@decorator<\/span>/.test(hl.html[0]) && /<span class="d">Foo<\/span>/.test(hl.html[9]));
  ok("multi-line string: continuation lines flagged and highlighted as string", hl.inString[3] === true && hl.inString[4] === true && hl.inString[2] === false && /<span class="s">/.test(hl.html[3]) && !/<span class="k">/.test(hl.html[3]));
  ok("html in source is escaped", hl.html[3].includes("&lt;b&gt;") && !hl.html[3].includes("<b>"));
  ok("an unterminated string does not swallow the next line", !hl.inString[12] && /<span class="n">1<\/span>/.test(hl.html[12]));
  for (const f of [join(FX, "toy.py"), join(FX, "shapes.py"), "D:/02_Learning_Knowledge/Python_Master/python-master-bang-b/luyen_tap/p1_doc_hieu.py"]) {
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
    if (src[src.length - 1] === "") src.pop();
    const h2 = lib.highlightSource(src);
    ok(`highlighter preserves ${f.split(/[\\/]/).pop()} line by line`, h2.html.length === src.length && h2.html.every((h, i) => unesc(h) === src[i]));
  }

  /* ───────── 4. delta and model ───────── */
  section("delta and model");
  const rnd = (() => {
    let s = 12345;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  })();
  const randVal = (d = 0) => {
    const x = rnd();
    if (d > 2 || x < 0.3) return Math.floor(rnd() * 20);
    if (x < 0.5) return Array.from({ length: Math.floor(rnd() * 12) }, () => randVal(d + 1));
    if (x < 0.65) return { __set__: [...new Set(Array.from({ length: Math.floor(rnd() * 10) }, () => Math.floor(rnd() * 30)))].sort((p, q) => p - q) };
    if (x < 0.8) return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 8) }, (_, i) => [`k${i}`, randVal(d + 1)]));
    return { __dict__: Array.from({ length: Math.floor(rnd() * 8) }, (_, i) => [{ __tuple__: [i, i + 1] }, randVal(d + 1)]) };
  };
  const mutate = (v) => {
    if (Array.isArray(v)) {
      const a = v.slice();
      const op = rnd();
      if (op < 0.4) a.push(Math.floor(rnd() * 20));
      else if (op < 0.6) a.pop();
      else if (a.length) a[Math.floor(rnd() * a.length)] = Math.floor(rnd() * 20);
      return a;
    }
    if (v && typeof v === "object" && Array.isArray(v.__set__)) {
      const s = v.__set__.slice();
      if (rnd() < 0.5) s.push(40 + Math.floor(rnd() * 20));
      else s.pop();
      return { ...v, __set__: [...new Set(s)].sort((p, q) => p - q) };
    }
    if (v && typeof v === "object" && Array.isArray(v.__dict__)) {
      const p = v.__dict__.slice();
      if (rnd() < 0.5) p.push([{ __tuple__: [90 + p.length, 1] }, 1]);
      else p.pop();
      return { ...v, __dict__: p };
    }
    if (v && typeof v === "object") {
      const o = { ...v };
      if (rnd() < 0.5) o[`n${Math.floor(rnd() * 5)}`] = Math.floor(rnd() * 9);
      else delete o[Object.keys(o)[0]];
      return o;
    }
    return typeof v === "number" ? v + 1 : v;
  };
  let patchOk = true;
  let patched = 0;
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) && Array.isArray(x.__set__) ? { ...x, __set__: [...x.__set__].map((e) => JSON.stringify(e)).sort() } : x));
  for (let i = 0; i < 400; i++) {
    const a = randVal();
    const b = mutate(a);
    const p = lib.diffValue(a, b);
    if (p) {
      patched++;
      const back = lib.applyPatch(a, p);
      const same = lib.deepEqual(back, b) || canon(back) === canon(b);
      if (!same) {
        patchOk = false;
        console.log("patch mismatch", JSON.stringify(a), JSON.stringify(b), JSON.stringify(p), JSON.stringify(back));
        break;
      }
    }
  }
  ok("diff/apply round-trips random containers", patchOk && patched > 100, `${patched} patches`);

  /* model against the recorded trace */
  const buildFor = async (tracePath, extra = {}) => lib.buildPlayer({ title: "Kiểm thử mô hình", trace: tracePath, ...extra });
  const modelCheck = async (label, tracePath) => {
    const built = await buildFor(tracePath);
    const html = readFileSync(built.indexPath, "utf8");
    const data = JSON.parse(/<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/.exec(html)[1]);
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    const m = new lib.Model(data);
    const evs = trace.steps.filter((s) => s.ev !== "call");
    let bad = 0;
    evs.slice(0, data.steps.length).forEach((e, k) => {
      if (e.ev !== "line") return;
      const st = m.frameState(k);
      const want = { ...e.locals };
      for (const [pk, pv] of Object.entries(e.probes ?? {})) want[`@${pk}`] = pv;
      const sortKeys = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
      if (sortKeys(st.vars) !== sortKeys(want)) bad++;
      if ([...st.changed].filter((n) => !n.startsWith("@")).sort().join() !== [...e.changed].sort().join()) bad++;
    });
    ok(`player model reproduces the recorded locals (${label})`, bad === 0 && data.steps.length === Math.min(evs.length, 5000), `${data.steps.length} steps, ${bad} mismatches`);
    return { data, html, trace, built };
  };
  await modelCheck("triangular", join(TEST_DIR, "o_tri", "trace.json"));
  await modelCheck("exception run", join(TEST_DIR, "o_boom", "trace.json"));

  /* ───────── 5. build and check ───────── */
  section("build and check");
  const specGood = {
    title: "Tổng 1 đến n",
    subtitle: "triangular(5)",
    trace: join(TEST_DIR, "o_tri", "trace.json"),
    viz: [{ kind: "table", var: "total" }],
    counters: [{ label: "TỔNG", expr: "total" }, { label: "Vòng lặp", line_hits: 3 }],
    stops: [
      { at: { line: 4, hit: 2 }, ask: "Sau dòng 4 lần thứ 2, `total` bằng bao nhiêu?", expect: { expr: "total" }, explain: "1 + 2 = 3" },
      { at: { line: 3, hit: 3 }, ask: "Dòng nào chạy tiếp theo?", expect: { line_next: true } },
      { at: { line: 3, hit: 1 }, ask: "Vòng lặp chạy bao nhiêu lần?", expect: { choice: ["4", "5", "6"], answer: 1 } },
      { at: { line: 5 }, ask: "Hàm trả về?", expect: { expr: "return" } },
    ],
    narration: { "4": "Cộng k vào tổng." },
    course: "Kiểm thử",
    lesson: "Bài 1",
  };
  r = await call("mira_check", { spec: specGood });
  ok("mira_check accepts a good spec (warns on viz type)", !r.isError && textOf(r).includes("Spec hợp lệ: 14 bước, 4 điểm dừng"), textOf(r).split("\n")[0]);
  r = await call("mira_build", { spec: specGood });
  const buildText = textOf(r);
  ok("mira_build writes index.html", !r.isError && buildText.includes("Đã tạo player"), buildText.split("\n")[0]);
  const indexPath = pathAfter(buildText, "# Đã tạo player:");
  ok("index.html exists next to the trace", indexPath === join(TEST_DIR, "o_tri", "index.html") && existsSync(indexPath));
  const html = readFileSync(indexPath, "utf8");
  ok("html is under 3 MB", Buffer.byteLength(html) < 3 * 1024 * 1024, `${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
  ok("html has the generator and mira-player meta tags", html.includes('<meta name="generator" content="mira-mcp 0.1.0">') && html.includes('<meta name="mira-player" content="1">'));
  const dataM = /<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/.exec(html);
  const pdata = dataM ? JSON.parse(dataM[1]) : null;
  ok("embedded spec data parses (title, stops, counters, source)", pdata && pdata.meta.title === "Tổng 1 đến n" && pdata.stops.length === 4 && pdata.counters.length === 2 && pdata.source[0] === "def triangular(n):");
  ok("embedded trace steps match the recording", pdata && pdata.steps.length === 14 && pdata.stdout === "" && pdata.result === "15");
  ok("no external URLs except the SVG namespace", noExternalUrls(html).length === 0, noExternalUrls(html).slice(0, 3).join(" "));
  ok("page has no emoji", !EMOJI.test(html));
  ok("fonts are inlined as data URIs", (html.match(/url\(data:font\/woff2;base64,/g) ?? []).length >= 5);
  ok("mira_build prints an Aurora trace slide", /"type": "trace"/.test(buildText) && buildText.includes('"eyebrow": "Dò code"') && buildText.includes("4 điểm dừng, 14 bước"));
  const slideJson = JSON.parse(/```json\s*([\s\S]*?)```/.exec(buildText)[1]);
  ok("aurora slide shape", slideJson.type === "trace" && slideJson.title === "Tổng 1 đến n" && slideJson.player === indexPath && slideJson.caption === "4 điểm dừng, 14 bước");

  const bad1 = await call("mira_check", { spec: { ...specGood, stops: [{ at: { line: 99 }, ask: "?", expect: { expr: "total" } }] } });
  ok("check rejects a stop on a never-hit line with a suggestion", bad1.isError && /dòng 99 chưa bao giờ chạy/.test(textOf(bad1)) && /Dòng gần nhất đã chạy: 5/.test(textOf(bad1)), textOf(bad1).slice(0, 200));
  const bad1b = await call("mira_check", { spec: { ...specGood, stops: [{ at: { line: 4, hit: 9 }, ask: "?", expect: { expr: "total" } }] } });
  ok("check rejects a hit number beyond the executions", bad1b.isError && /chỉ chạy 5 lần/.test(textOf(bad1b)));
  const bad2 = await call("mira_check", { spec: { ...specGood, stops: [{ at: { line: 4 }, ask: "?", expect: { expr: "totl" } }] } });
  ok("check rejects an unknown expr with a closest suggestion", bad2.isError && /Có phải "total"\?/.test(textOf(bad2)), textOf(bad2).slice(0, 220));
  const bad3 = await call("mira_check", { spec: { ...specGood, viz: [{ kind: "array", var: "arr" }] } });
  ok("check rejects an unknown viz var", bad3.isError && /không tìm thấy biến "arr"/.test(textOf(bad3)));
  const bad4 = await call("mira_check", { spec: { ...specGood, viz: [{ kind: "array", var: "total" }], extra_field: 1 } });
  ok("check rejects unknown spec keys with a hint", bad4.isError && /extra_field/.test(textOf(bad4)));
  const bad5 = await call("mira_check", { spec: { ...specGood, stops: [{ at: { line: 3, hit: 6 }, ask: "?", expect: { line_next: true } }] } });
  ok("line_next on a line that leaves the loop is still valid (next is the return line)", !bad5.isError);
  const bad6 = await call("mira_check", { spec: { ...specGood, stops: [{ at: { line: 5 }, ask: "?", expect: { line_next: true } }] } });
  ok("line_next on a return line is rejected", bad6.isError && /kết thúc hàm/.test(textOf(bad6)));
  const bad7 = await call("mira_build", { spec: { ...specGood, trace: join(TEST_DIR, "nope", "trace.json") } });
  ok("build reports a missing trace", bad7.isError && /Không tìm thấy trace/.test(textOf(bad7)));

  /* ───────── 6. drill ───────── */
  section("drill");
  r = await call("mira_drill", { file: join(FX, "scaler.py"), function: "scale_all", out_dir: join(TEST_DIR, "d_scale") });
  const drillText = textOf(r);
  ok("drill derives the call from a docstring example", !r.isError && drillText.includes("scale_all([1, 2, 3], 2)") && drillText.includes("lấy từ ví dụ trong docstring"), drillText.split("\n").slice(0, 2).join(" | "));
  const qn = (drillText.match(/^\d+\. \[dòng \d+\]/gm) ?? []).length;
  ok("drill produces 3-4 stops and prints questions only", qn >= 3 && qn <= 4 && !drillText.includes("[2, 4, 6]") && !/Thực tế/.test(drillText), `${qn} stops`);
  const dHtml = readFileSync(join(TEST_DIR, "d_scale", "index.html"), "utf8");
  const dData = JSON.parse(/<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/.exec(dHtml)[1]);
  ok("drill player: array viz for the list argument, loop counter, return stop", dData.viz[0]?.kind === "array" && dData.viz[0].var === "values" && dData.counters.some((c) => c.lineHits === 5) && dData.stops.some((s) => s.expr === "return"), JSON.stringify(dData.counters));
  ok("drill player has the meta tags and no external URLs", dHtml.includes('name="mira-player"') && noExternalUrls(dHtml).length === 0);
  r = await call("mira_drill", { file: join(FX, "scaler.py"), function: "broken", call: "broken(1)", out_dir: join(TEST_DIR, "d_broken") });
  ok("drill refuses a function containing ___1___", Boolean(r.isError) && textOf(r).includes("Hoàn thành chỗ trống trước khi dò code."), textOf(r));
  ok("refused drill writes nothing", !existsSync(join(TEST_DIR, "d_broken")));
  r = await call("mira_drill", { file: join(FX, "scaler.py"), function: "no_example", out_dir: join(TEST_DIR, "d_none") });
  ok("drill without call or docstring example asks for call", Boolean(r.isError) && /Hãy truyền `call`/.test(textOf(r)));
  r = await call("mira_drill", { file: join(FX, "scaler.py"), function: "scale_al", out_dir: join(TEST_DIR, "d_typo") });
  ok("drill suggests the closest function name", Boolean(r.isError) && /Có phải "scale_all"\?/.test(textOf(r)));

  // Vietnamese path (spaces, parentheses, diacritics) and Vietnamese identifiers
  const viDir = join(FX, "Bài tập (thử)");
  mkdirSync(viDir, { recursive: true });
  writeFileSync(join(viDir, "tổng hợp.py"), 'def nhân_đôi(số):\n    """nhân_đôi(21) -> 42"""\n    kết_quả = số * 2\n    return kết_quả\n', "utf8");
  r = await call("mira_drill", { file: join(viDir, "tổng hợp.py"), function: "nhân_đôi", out_dir: join(TEST_DIR, "d_vi") });
  const viData = existsSync(join(TEST_DIR, "d_vi", "index.html")) ? JSON.parse(/<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/.exec(readFileSync(join(TEST_DIR, "d_vi", "index.html"), "utf8"))[1]) : null;
  ok("drill works with a Vietnamese path and Vietnamese identifiers", !r.isError && viData && viData.stops.some((s) => s.expr === "kết_quả" || s.expr === "return") && viData.steps.length === 3, textOf(r).split("\n").slice(0, 2).join(" | "));
  ok("slug of a Vietnamese title is plain ASCII", lib.slugify("Đường đi ngắn nhất: A* & Dijkstra!") === "duong-di-ngan-nhat-a-dijkstra" && lib.slugify("???") === "mira");
  ok("fixture folder with a Vietnamese name has no __pycache__", !existsSync(join(viDir, "__pycache__")));

  const realFile = "D:/02_Learning_Knowledge/Python_Master/python-master-bang-b/luyen_tap/p1_doc_hieu.py";
  if (existsSync(realFile)) {
    const realDir = dirname(realFile);
    const listing = () => readdirSync(realDir).sort().join("|") + "#" + readdirSync(join(realDir, "__pycache__")).sort().join("|");
    const before = listing();
    r = await call("mira_drill", { file: realFile, function: "tong_chu_so", out_dir: join(TEST_DIR, "d_real") });
    ok("real tong_chu_so drill works (read-only source, output under %TEMP%)", !r.isError && existsSync(join(TEST_DIR, "d_real", "index.html")) && textOf(r).includes("tong_chu_so(-4567)"), textOf(r).split("\n")[0]);
    ok("the learner's luyen_tap folder is unchanged (no __pycache__ entries or files added)", listing() === before);
    r = await call("mira_drill", { file: realFile, function: "doi_co_so", out_dir: join(TEST_DIR, "d_real2") });
    ok("drill derives a call from f(args) -> result in the middle of a docstring", !r.isError && textOf(r).includes('doi_co_so(255, 16)'), textOf(r).split("\n").slice(0, 2).join(" | "));
  } else {
    console.log("skip real-file drill: the learner's file is not present");
  }

  /* ───────── 7. demo ───────── */
  section("demo");
  const demoDir = join(TEST_DIR, "demo");
  const td = Date.now();
  r = await call("mira_demo", { out_dir: demoDir });
  const demoText = textOf(r);
  ok("mira_demo succeeds", !r.isError && demoText.includes("A* xét ít hơn Dijkstra"), `${((Date.now() - td) / 1000).toFixed(1)}s`);
  for (const f of ["grid_search.py", "index.html", "astar/index.html", "astar/trace.json", "dijkstra/index.html", "dijkstra/trace.json"]) {
    ok(`demo wrote ${f}`, existsSync(join(demoDir, f)));
  }
  {
    const demoSrc = readFileSync(join(demoDir, "grid_search.py"), "utf8").split(/\r?\n/);
    if (demoSrc[demoSrc.length - 1] === "") demoSrc.pop();
    const unescD = (h) => h.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    ok("demo program (Vietnamese comments) survives highlighting line by line", lib.highlightSource(demoSrc).html.every((h, i) => unescD(h) === demoSrc[i]));
  }
  const astarTrace = JSON.parse(readFileSync(join(demoDir, "astar", "trace.json"), "utf8"));
  const dijTrace = JSON.parse(readFileSync(join(demoDir, "dijkstra", "trace.json"), "utf8"));
  const res = (t) => ({ path: t.resultValue.__tuple__[0].length, visited: t.resultValue.__tuple__[1] });
  const ra = res(astarTrace);
  const rd = res(dijTrace);
  ok("A* visited count < Dijkstra visited count", ra.visited < rd.visited, `${ra.visited} < ${rd.visited}`);
  ok("both find the same path length", ra.path === rd.path && ra.path > 10, `${ra.path} cells`);
  ok("both traces are complete (not truncated)", !astarTrace.truncated && !dijTrace.truncated, `${astarTrace.steps.length} and ${dijTrace.steps.length} events`);
  const hub = readFileSync(join(demoDir, "index.html"), "utf8");
  ok("hub page links both players with the final visited counts", hub.includes('href="astar/index.html"') && hub.includes('href="dijkstra/index.html"') && hub.includes(`>${ra.visited}<`) && hub.includes(`>${rd.visited}<`) && hub.includes("A* xét ít ô hơn Dijkstra bao nhiêu"));
  const demoHtml = {};
  for (const k of ["astar", "dijkstra"]) {
    const h = readFileSync(join(demoDir, k, "index.html"), "utf8");
    demoHtml[k] = h;
    const d = JSON.parse(/<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/.exec(h)[1]);
    ok(`${k}: grid viz, counters, 3 stops, narration, meta`, d.viz[0].kind === "grid" && d.counters.length >= 2 && d.stops.length === 3 && Object.keys(d.narration).length >= 8 && h.includes('name="mira-player"'));
    ok(`${k}: size < 3 MB and no external URLs, no emoji`, Buffer.byteLength(h) < 3 * 1024 * 1024 && noExternalUrls(h).length === 0 && !EMOJI.test(h), `${(Buffer.byteLength(h) / 1024).toFixed(0)} KB`);
    ok(`${k}: all ${d.steps.length} steps embedded (no trimming)`, d.steps.length === astarTrace.steps.filter((s) => s.ev !== "call").length || d.steps.length === dijTrace.steps.filter((s) => s.ev !== "call").length);
  }
  ok("hub page has no external URLs and no emoji", noExternalUrls(hub).length === 0 && !EMOJI.test(hub));
  await modelCheck("A* demo trace", join(demoDir, "astar", "trace.json"));
  await modelCheck("Dijkstra demo trace", join(demoDir, "dijkstra", "trace.json"));

  /* ───────── 8. player smoke tests with the fake DOM ───────── */
  section("player (fake DOM)");
  const stepThrough = (p, label) => {
    const next = p.byAria("Bước kế tiếp");
    const prev = p.byAria("Bước trước");
    const counter = () => p.byClass("stepno")[0]?.textContent ?? "";
    const total = Number(/\/(\d+)/.exec(counter())?.[1] ?? 0);
    let guard = 0;
    let gates = 0;
    while (!/^Bước (\d+)\/\1$/.test(counter()) && guard++ < total + 10) {
      p.click(next);
      const gate = p.byClass("gate")[0];
      if (gate && p.visible(gate)) {
        gates++;
        const skip = p.all((e) => e.tagName === "BUTTON" && e.textContent === "Bỏ qua")[0];
        if (skip) p.click(skip);
        const cont = p.all((e) => e.tagName === "BUTTON" && e.textContent === "Tiếp tục")[0];
        if (cont) p.click(cont);
      }
    }
    ok(`${label}: stepped to the last step without errors`, p.errors.length === 0 && /^Bước (\d+)\/\1$/.test(counter()), counter());
    for (let i = 0; i < 6; i++) p.click(prev);
    return gates;
  };

  // generic viz coverage: array+table+plot, then statevector+graph+heap, then stack+queue+grid-less
  const shapesRec = await lib.recordTrace({ file: join(FX, "shapes.py"), call: "data_shapes()", out_dir: join(TEST_DIR, "o_shapes") });
  const lastLine = shapesRec.trace.steps.filter((s) => s.ev === "line").pop().line;
  const vizSets = [
    ["array+table+plot", [{ kind: "array", var: "arr", pointers: ["i"] }, { kind: "table", var: "table" }, { kind: "plot", var: "losses", y_label: "mất mát" }]],
    ["statevector+graph+heap", [{ kind: "statevector", var: "state" }, { kind: "graph", adjacency: "graph", visited: "seen" }, { kind: "heap", var: "heap" }]],
    ["stack+queue", [{ kind: "stack", var: "stack" }, { kind: "queue", var: "queue" }]],
  ];
  const smokePlayers = [];
  for (const [label, viz] of vizSets) {
    const b = await lib.buildPlayer({
      title: `Hình dạng ${label}`,
      trace: join(TEST_DIR, "o_shapes", "trace.json"),
      out_dir: join(TEST_DIR, `o_shapes_${label.replace(/\W+/g, "_")}`),
      viz,
      stops: [{ at: { line: lastLine }, ask: "Hàm trả về?", expect: { expr: "return" } }],
    });
    ok(`build ${label}`, b.ok, b.errors.join("; ").slice(0, 160));
    smokePlayers.push([label, readFileSync(b.indexPath, "utf8")]);
  }
  for (const [label, h] of smokePlayers) {
    const p = bootPlayer(h);
    ok(`${label}: player boots without errors`, p.errors.length === 0 && p.byClass("app").length === 1, p.errors[0]?.message);
    stepThrough(p, label);
    const tabs = p.byClass("tab");
    for (const t of tabs) p.click(t);
    ok(`${label}: every viz tab renders after the last step`, p.errors.length === 0 && tabs.length === 3 || label.startsWith("stack"));
  }
  // no viz configured: a trace table that never shows the result ahead of time
  {
    const nb = await lib.buildPlayer({ title: "Không viz", trace: join(TEST_DIR, "o_tri", "trace.json"), out_dir: join(TEST_DIR, "o_noviz") });
    ok("build with no viz is allowed (warns)", nb.ok && nb.warnings.some((w) => w.includes("chưa có viz")));
    const p = bootPlayer(readFileSync(nb.indexPath, "utf8"));
    ok("no-viz player boots with a trace table", p.errors.length === 0 && p.byClass("trace").length === 1 && p.byClass("trace-tbl").length === 1);
    ok("a player without stops marks the controls no-stops (grid columns) and has no stop button", p.byClass("controls")[0].classList.contains("no-stops") && p.byClass("stop-btn")[0].style.display === "none" && p.byClass("tick").length === 0);
    ok("a player without counters marks the app no-counters", p.byClass("app")[0].classList.contains("no-counters") && p.byClass("counters").length === 0);
    const vizText = () => p.byClass("viz-body")[0].textContent;
    const rowsNow = () => p.byClass("trace-tbl")[0].querySelector("tbody").children.length;
    ok("trace table starts with the first state only and does not reveal the result (15)", rowsNow() === 1 && !/\b15\b/.test(vizText()), vizText().slice(0, 80));
    const nextBtn = p.byAria("Bước kế tiếp");
    for (let i = 0; i < 9; i++) p.click(nextBtn);
    ok("rows appear as the run progresses", rowsNow() > 3 && rowsNow() <= 10, String(rowsNow()));
    ok("... and still no future result", !/\b15\b/.test(vizText()));
    for (let i = 0; i < 20; i++) p.click(nextBtn);
    ok("at the end the table has the final accumulated total", p.byClass("trace-tbl")[0].querySelectorAll("td").some((td) => td.textContent === "15") && p.errors.length === 0);
  }

  // grid + counters + gate flow on the real demo
  {
    const p = bootPlayer(demoHtml.astar, { protocol: "http:" });
    ok("A* demo: boots, grid canvas and counters present", p.errors.length === 0 && p.byClass("grid-canvas").length === 1 && p.byClass("ctr").length === 3);
    const next = p.byAria("Bước kế tiếp");
    const nextStop = p.all((e) => e.tagName === "BUTTON" && e.textContent.includes("Điểm dừng tiếp theo"))[0];
    p.click(nextStop);
    const gate = p.byClass("gate")[0];
    ok("A* demo: next-stop button opens the first prediction gate", p.visible(gate) && p.byClass("gate-q")[0].textContent.includes("cell"), p.byClass("gate-q")[0]?.textContent.slice(0, 60));
    const stepBefore = p.byClass("stepno")[0].textContent;
    p.click(next);
    ok("gate blocks stepping until answered or skipped", p.byClass("stepno")[0].textContent === stepBefore);
    const input = p.byClass("gate-input")[0];
    input.value = "(0, 0)";
    input.dispatchEvent(new FakeEvent("keydown", { key: "Enter" }));
    const verdict = p.byClass("gate-verdict")[0];
    ok("wrong answer is graded as different and reveals the real value", verdict && verdict.classList.contains("diff") && p.byClass("fact-v").length === 2, verdict?.textContent);
    ok("event was POSTed to /__mira/progress over http", p.fetchCalls.length === 1 && p.fetchCalls[0].url === "/__mira/progress" && JSON.parse(p.fetchCalls[0].init.body).slideId === "mira-stop-1");
    const stored = JSON.parse([...p.storage.entries()].find(([k]) => k.endsWith(":events"))[1]);
    ok("event stored in the localStorage ring buffer under mira:<slug>:events", stored.length === 1 && [...p.storage.keys()].some((k) => /^mira:a-tren-luoi-18-28:events$/.test(k)), [...p.storage.keys()].join(","));
    smokeEvents.push(...stored);
    p.click(p.all((e) => e.tagName === "BUTTON" && e.textContent === "Tiếp tục")[0]);
    ok("continuing closes the gate", !p.visible(gate));
    // answer the second stop correctly using the model
    p.click(nextStop);
    const d = JSON.parse(/<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/.exec(demoHtml.astar)[1]);
    const m = new lib.Model(d);
    const stop2 = d.stops[1];
    const real = m.stopOutcome(stop2).value;
    p.byClass("gate-input")[0].value = lib.pyRepr(real);
    p.byClass("gate-input")[0].dispatchEvent(new FakeEvent("keydown", { key: "Enter" }));
    ok("correct answer (typed as Python literal) is graded right", p.byClass("gate-verdict")[0].classList.contains("right"), `${lib.pyRepr(real)}`);
    p.click(p.all((e) => e.tagName === "BUTTON" && e.textContent === "Tiếp tục")[0]);
    // keyboard shortcuts
    const s0 = p.byClass("stepno")[0].textContent;
    p.key("ArrowRight");
    p.key("ArrowLeft");
    ok("keyboard: ArrowRight/ArrowLeft step", p.byClass("stepno")[0].textContent === s0);
    p.key("End");
    ok("End jumps to the last step, skipping the unanswered stop", /^Bước (\d+)\/\1$/.test(p.byClass("stepno")[0].textContent));
    const evs = [...JSON.parse([...p.storage.entries()].find(([k]) => k.endsWith(":events"))[1])];
    ok(
      "passing a stop marks it skipped; the end emits a complete event with x/y",
      evs.some((e) => e.slideId === "mira-stop-3" && e.prediction === "(bỏ qua)" && e.rating === "different") && evs.some((e) => e.type === "complete" && e.predictions === "1/3" && e.slides === d.steps.length),
      JSON.stringify(evs.map((e) => [e.slideId, e.rating])),
    );
    smokeEvents.push(...evs.filter((e) => !smokeEvents.some((s) => JSON.stringify(s) === JSON.stringify(e))));
    p.key("Home");
    ok("Home jumps back to step 1", /^Bước 1\//.test(p.byClass("stepno")[0].textContent));
    // export button
    const exportBtn = p.all((e) => e.tagName === "BUTTON" && e.textContent.includes("Xuất tiến độ"))[0];
    p.click(exportBtn);
    ok("export progress button works without errors", p.errors.length === 0 && Boolean(exportBtn));
    // deep link
    const q = bootPlayer(demoHtml.astar, { hash: "#stop-2" });
    ok("deep link #stop-2 opens the player at stop 2 with its gate", q.errors.length === 0 && q.visible(q.byClass("gate")[0]) && q.byClass("gate-count")[0].textContent.includes("Điểm dừng 2/3"), q.byClass("gate-count")[0]?.textContent);
    const pos2 = d.stops[1].pos;
    ok("deep link shows the state just before the gate", q.byClass("stepno")[0].textContent === `Bước ${pos2 + 1}/${d.steps.length}`, q.byClass("stepno")[0].textContent);
    // autoplay stops at the gate
    const a = bootPlayer(demoHtml.astar);
    a.click(a.all((e) => e.tagName === "BUTTON" && (e.getAttribute("aria-label") ?? "").includes("Chạy tự động"))[0]);
    let safety = 0;
    while (!a.visible(a.byClass("gate")[0]) && safety++ < 3000) a.runTimers(1);
    ok("autoplay pauses at the first prediction stop", a.visible(a.byClass("gate")[0]) && a.errors.length === 0, `after ${safety} ticks`);
  }

  // choice stop + embed mode
  {
    const e = bootPlayer(readFileSync(indexPath, "utf8"), { embed: true, protocol: "http:" });
    ok("embed: boots and posts a ready message to the parent", e.errors.length === 0 && e.messages[0]?.m.kind === "ready" && e.messages[0].m.source === "mira" && e.messages[0].m.v === 1 && e.messages[0].m.title === "Tổng 1 đến n" && e.messages[0].m.steps === 14 && e.messages[0].m.stops === 4, JSON.stringify(e.messages[0]?.m));
    ok("embed: app is flagged data-embed=1 and the export button is hidden", e.byClass("app")[0].getAttribute("data-embed") === "1" && !e.all((x) => x.tagName === "BUTTON" && x.textContent.includes("Xuất tiến độ")).length);
    const nextStopBtn = () => e.all((x) => x.tagName === "BUTTON" && x.textContent.includes("Điểm dừng tiếp theo"))[0];
    const goOn = () => e.click(e.all((x) => x.tagName === "BUTTON" && x.textContent === "Tiếp tục")[0]);
    e.click(nextStopBtn());
    ok("embed: first stop of the spec is the choice question", e.byClass("choice").length === 3);
    e.click(e.byClass("choice")[1]);
    goOn();
    e.click(nextStopBtn());
    e.byClass("gate-input")[0].value = "3";
    e.byClass("gate-input")[0].dispatchEvent(new FakeEvent("keydown", { key: "Enter" }));
    const evMsgs = e.messages.filter((x) => x.m.kind === "event");
    const evMsg = evMsgs[1];
    ok("embed: predict events are posted to the parent, not to /__mira/progress", evMsgs.length === 2 && evMsg.m.event.type === "predict" && evMsg.m.event.slideId === "mira-stop-2" && evMsg.m.event.rating === "right" && e.fetchCalls.length === 0 && evMsg.origin === "*", JSON.stringify(evMsg?.m.event).slice(0, 120));
    ok("embed: the localStorage buffer is still kept", [...e.storage.keys()].some((k) => k.endsWith(":events")));
    // hello: theme and accent
    e.dispatchWindow("message", { data: { source: "aurora", v: 1, kind: "hello", theme: "light", accent: "#12ab9c" } });
    ok("embed: hello applies theme and a valid accent", e.doc.documentElement.getAttribute("data-theme") === "light" && e.doc.documentElement.style.getPropertyValue("--accent") === "#12AB9C");
    e.dispatchWindow("message", { data: { source: "evil", v: 1, kind: "hello", theme: "dark", accent: "#000000" } });
    e.dispatchWindow("message", { data: { source: "aurora", v: 1, kind: "hello", accent: "red; background:url(x)" } });
    ok("embed: messages from other sources and invalid accents are ignored", e.doc.documentElement.getAttribute("data-theme") === "light" && e.doc.documentElement.style.getPropertyValue("--accent") === "#12AB9C");
    e.doc.focused = false;
    const before = e.byClass("stepno")[0].textContent;
    goOn();
    e.key("ArrowRight");
    ok("embed: shortcuts act only while the iframe document has focus", e.byClass("stepno")[0].textContent === before);
    e.doc.focused = true;
    e.key("Escape");
    ok("embed: Escape posts a blur message to the parent", e.messages.some((x) => x.m.kind === "blur" && x.m.source === "mira" && x.m.v === 1));
    // choice gate: the first stop of the spec
    const c = bootPlayer(readFileSync(indexPath, "utf8"), { embed: true });
    c.click(c.all((x) => x.tagName === "BUTTON" && x.textContent.includes("Điểm dừng tiếp theo"))[0]);
    const choices = c.byClass("choice");
    ok("choice stop renders its options", choices.length === 3 && choices[1].textContent.includes("5"));
    c.click(choices[1]);
    ok("choice stop: picking the right option is graded right", c.byClass("gate-verdict")[0]?.classList.contains("right"));
    c.click(c.all((x) => x.tagName === "BUTTON" && x.textContent === "Tiếp tục")[0]);
    c.click(c.all((x) => x.tagName === "BUTTON" && x.textContent.includes("Điểm dừng tiếp theo"))[0]);
    c.byClass("gate-input")[0].value = "99";
    c.byClass("gate-input")[0].dispatchEvent(new FakeEvent("keydown", { key: "Enter" }));
    ok("value stop: a wrong answer is graded different", c.byClass("gate-verdict")[0]?.classList.contains("diff"));
    smokeEvents.push(...c.messages.filter((x) => x.m.kind === "event").map((x) => x.m.event));
  }

  /* ───────── 8b. layout in a real browser (device emulation; the fake DOM cannot judge layout) ───────── */
  section("layout (headless Chrome, device emulation)");
  {
    const shots = await import(pathToFileURL(join(ROOT, "scripts", "shots.mjs")).href);
    const chromePath = shots.findChrome();
    if (process.env.MIRA_E2E_NO_BROWSER) {
      console.log("skip layout checks: MIRA_E2E_NO_BROWSER is set");
    } else if (!chromePath) {
      console.log("skip layout checks: Chrome not found (set MIRA_CHROME to chrome.exe or msedge.exe)");
    } else {
      // NOT demo/astar/index.html on disk: modelCheck above rebuilt that file as a bare player (no viz, counters or
      // stops) next to the trace. Measure a copy of the demo page exactly as the fake-DOM tests saw it.
      const layoutDir = join(TEST_DIR, "layout");
      mkdirSync(layoutDir, { recursive: true });
      const astarFile = join(layoutDir, "astar.html");
      writeFileSync(astarFile, demoHtml.astar, "utf8");
      const astarData = JSON.parse(/<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/.exec(demoHtml.astar)[1]);
      ok("layout fixture is the real A* demo page (grid viz, 3 counters, 3 stops)", astarData.viz[0]?.kind === "grid" && astarData.counters.length === 3 && astarData.stops.length === 3, `${astarData.viz.length} viz, ${astarData.counters.length} counters, ${astarData.stops.length} stops`);
      const A = (id, w, h, extra = {}) => ({ page: "astar", file: astarFile, id, w, h, ...extra });
      const plan = [
        A("desktop-1366x768", 1366, 768),
        A("embed-960x540", 960, 540, { query: "?embed=1" }),
        A("phone-390x844", 390, 844),
        A("phone-360x740", 360, 740),
        A("embed-390x844", 390, 844, { query: "?embed=1" }),
        A("stop2-390x844", 390, 844, { hash: "#stop-2" }),
        A("stress-360x740", 360, 740, { hash: "#stop-2", prelude: "stress" }),
        { page: "hub", file: join(demoDir, "index.html"), id: "phone-390x844", w: 390, h: 844 },
        { page: "noviz", file: join(TEST_DIR, "o_noviz", "index.html"), id: "phone-390x844", w: 390, h: 844 },
      ];
      let browser;
      try {
        browser = await shots.launchChrome(chromePath);
      } catch (e) {
        ok("headless Chrome starts", false, String(e instanceof Error ? e.message : e));
      }
      if (browser) {
        try {
          const { rows } = await shots.measureCases(plan, { browser });
          const row = (page, id) => rows.find((r) => r.page === page && r.id === id);
          const why = (r) => (r ? r.offenders.slice(0, 3).map((o) => `${o.sel}@${o.right}`).join(", ") || r.problems.join("; ") : "no row");
          for (const r of rows) {
            ok(`${r.page} ${r.id}: nothing sticks out of the viewport (scrollWidth ${r.scrollWidth} <= clientWidth ${r.clientWidth})`, !r.overflow, why(r));
            ok(`${r.page} ${r.id}: no clipped caption, crushed title or oversized canvas`, r.issues.length === 0, r.issues.join("; "));
          }
          ok("real Chrome ran every player without a page error", rows.every((r) => r.errors.length === 0), rows.flatMap((r) => r.errors).slice(0, 2).join(" | "));
          const dt = row("astar", "desktop-1366x768");
          ok("desktop 1366x768: the shell fits the window (the page does not scroll)", Boolean(dt) && !dt.vScroll, `${dt?.scrollHeight}/${dt?.clientHeight}`);
          const em = row("astar", "embed-960x540");
          // smallest height (px) each essential part must keep when the whole player lives in a 960x540 frame
          const essential = { viz: 150, code: 100, vars: 60, controls: 40 };
          ok(
            "embed 960x540: viz, code, variables and controls are all inside the window, no page scroll",
            Boolean(em) && !em.vScroll && Object.entries(essential).every(([n, min]) => em.parts[n] && em.parts[n].bottom <= em.innerHeight && em.parts[n].height >= min),
            JSON.stringify(Object.fromEntries(Object.entries(em?.parts ?? {}).map(([k, v]) => [k, `${v.top}-${v.bottom}`]))),
          );
          const ph = row("astar", "phone-390x844");
          ok("phone 390: the code pane scrolls inside itself (it is wider than its box, the page is not)", Boolean(ph) && ph.codeScroll.scrollWidth > ph.codeScroll.clientWidth && !ph.overflow, JSON.stringify(ph?.codeScroll));
          ok("phone 390: the grid canvas takes the width of its container", Boolean(ph) && ph.gridFit && Math.abs(ph.gridFit.canvas - ph.gridFit.wrap) <= 1, JSON.stringify(ph?.gridFit));
          ok("phone 390: the sticky control bar is compact (at most 20% of the screen height)", Boolean(ph) && ph.parts.controls.height <= 0.2 * ph.innerHeight, `${ph?.parts.controls.height}px of ${ph?.innerHeight}`);
          const gt = row("astar", "stop2-390x844");
          ok("phone 390 with a prediction gate open: the gate is not hidden behind the control bar", Boolean(gt) && Boolean(gt.parts.gate) && gt.parts.gate.bottom <= gt.parts.controls.top + 1, `gate bottom ${gt?.parts.gate?.bottom}, bar top ${gt?.parts.controls.top}`);
          const nv = row("noviz", "phone-390x844");
          ok("phone 390: a player without a viz (trace table pane) fits", Boolean(nv) && nv.isPlayer && !nv.overflow, why(nv));

          const caps = await shots.scanCaptions(
            [
              A("desktop-1366x768", 1366, 768),
              A("embed-960x540", 960, 540, { query: "?embed=1" }),
              A("phone-390x844", 390, 844),
              A("phone-360x740", 360, 740),
            ],
            { browser },
          );
          for (const c of caps) {
            ok(`${c.id}: all ${c.steps} captions fit their box (no half-cut line)`, c.steps > 900 && c.clipped === 0, c.samples[0] ? `step ${c.samples[0].step}: ${c.samples[0].box}` : "");
          }
        } catch (e) {
          ok("layout checks ran", false, e instanceof Error ? e.message : String(e));
        } finally {
          await browser.close();
        }
      }
    }
  }

  /* ───────── 9. embed protocol functions ───────── */
  section("embed protocol (pure functions)");
  const winTop = {};
  winTop.parent = winTop;
  winTop.location = { search: "" };
  ok("isEmbed false for a top-level window", lib.isEmbed(winTop) === false);
  ok("isEmbed true when parent differs", lib.isEmbed({ parent: {}, location: { search: "" } }) === true);
  const mk = (search) => { const w = { location: { search } }; w.parent = w; return w; };
  ok("isEmbed true for ?embed=1", lib.isEmbed(mk("?a=1&embed=1")) === true && lib.isEmbed(mk("?embed=0")) === false && lib.isEmbed(mk("")) === false);
  ok("ready/event/blur message shapes", JSON.stringify(lib.readyMessage({ title: "T", steps: 3, stops: 1 })) === '{"source":"mira","v":1,"kind":"ready","title":"T","steps":3,"stops":1}' && JSON.stringify(lib.eventMessage({ a: 1 })) === '{"source":"mira","v":1,"kind":"event","event":{"a":1}}' && JSON.stringify(lib.blurMessage()) === '{"source":"mira","v":1,"kind":"blur"}');
  ok("parseHello validates source, version, theme and the hex accent", JSON.stringify(lib.parseHello({ source: "aurora", v: 1, kind: "hello", theme: "dark", accent: "#aabbcc" })) === '{"theme":"dark","accent":"#AABBCC"}' && lib.parseHello({ source: "mira", v: 1, kind: "hello" }) === undefined && lib.parseHello({ source: "aurora", v: 2, kind: "hello" }) === undefined && JSON.stringify(lib.parseHello({ source: "aurora", v: 1, kind: "hello", theme: "neon", accent: "#12" })) === "{}" && lib.parseHello("x") === undefined);
  const posted = [];
  ok("postToParent posts with targetOrigin *", lib.postToParent({ parent: { postMessage: (m, o) => posted.push([m, o]) } }, lib.blurMessage()) && posted[0][1] === "*");

  /* ───────── 10. preview server ───────── */
  section("preview");
  const previewDir = join(TEST_DIR, "demo", "astar");
  r = await call("mira_preview", { dir: previewDir, port: 43190 + Math.floor(Math.random() * 500) });
  const url = /(http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(textOf(r))?.[1];
  ok("preview starts on 127.0.0.1 and replies with a URL", !r.isError && Boolean(url), url);
  const port = Number(/:(\d+)\//.exec(url)[1]);
  const httpReq = (method, path, body, headers = {}) =>
    new Promise((res, rej) => {
      const rq = http.request({ host: "127.0.0.1", port, method, path, headers }, (rs) => {
        const chunks = [];
        rs.on("data", (c) => chunks.push(c));
        rs.on("end", () => res({ status: rs.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      rq.on("error", rej);
      if (body) rq.write(body);
      rq.end();
    });
  let g = await httpReq("GET", "/index.html");
  ok("GET index.html -> 200 with the player", g.status === 200 && g.body.includes('name="mira-player"'));
  g = await httpReq("GET", "/");
  ok("GET / serves index.html", g.status === 200 && g.body.includes("mira-data"));
  g = await httpReq("GET", "/..%5c..%5cgrid_search.py");
  ok("GET outside the folder (encoded backslash traversal) -> 403/404", g.status === 403 || g.status === 404, String(g.status));
  g = await httpReq("GET", "/%2e%2e/%2e%2e/grid_search.py");
  ok("GET outside the folder (dot-dot) -> 403/404", g.status === 403 || g.status === 404 || !g.body.includes("def make_grid"), String(g.status));
  g = await httpReq("GET", "/nope.html");
  ok("GET missing file -> 404", g.status === 404);
  const goodEvent = { v: 1, t: "2026-10-12T10:00:00+07:00", deck: "A* trên lưới 18×28", slide: 3, slideId: "mira-stop-1", type: "predict", title: "Câu hỏi?", prediction: "(9, 7)", rating: "right", output: "(9, 7)" };
  g = await httpReq("POST", "/__mira/progress", JSON.stringify(goodEvent), { "Content-Type": "application/json" });
  ok("POST a contract-valid predict event -> 204", g.status === 204, String(g.status));
  const pj = join(previewDir, "progress.jsonl");
  ok("event appended to <dir>/progress.jsonl", existsSync(pj) && JSON.parse(readFileSync(pj, "utf8").trim().split("\n").pop()).slideId === "mira-stop-1");
  g = await httpReq("POST", "/__mira/progress", JSON.stringify({ ...goodEvent, v: 2 }), { "Content-Type": "application/json" });
  ok("invalid body (v: 2) rejected -> 400", g.status === 400);
  g = await httpReq("POST", "/__mira/progress", "{not json", { "Content-Type": "application/json" });
  ok("malformed JSON rejected -> 400", g.status === 400);
  g = await httpReq("POST", "/__mira/progress", JSON.stringify({ ...goodEvent, type: "quiz", question: "q", chosen: [0], answer: [0], correct: true }), { "Content-Type": "application/json" });
  ok("non-Mira event types rejected -> 400", g.status === 400);
  g = await httpReq("POST", "/__mira/progress", JSON.stringify(goodEvent), { "Content-Type": "text/plain" });
  ok("wrong content type rejected -> 415", g.status === 415);
  g = await httpReq("POST", "/__mira/progress", JSON.stringify(goodEvent), { "Content-Type": "application/json", Origin: "http://evil.example" });
  ok("foreign Origin rejected -> 403", g.status === 403);
  g = await httpReq("POST", "/__mira/progress", JSON.stringify({ ...goodEvent, prediction: "x".repeat(70000) }), { "Content-Type": "application/json" }).catch((e) => ({ status: /ECONNRESET|EPIPE/.test(String(e)) ? 413 : 0 }));
  ok("oversized body (> 64 KB) rejected -> 413", g.status === 413, String(g.status));
  g = await httpReq("POST", "/__mira/progress", JSON.stringify({ ...goodEvent, prediction: "y".repeat(2001) }), { "Content-Type": "application/json" });
  ok("prediction longer than the contract limit rejected -> 400", g.status === 400);
  r = await call("mira_preview", { dir: previewDir });
  ok("one server per folder (second call reuses it)", textOf(r).includes(`:${port}/`) && textOf(r).includes("đang chạy"));
  r = await call("mira_preview", { dir: previewDir, stop: true });
  ok("stop shuts the server down", !r.isError && textOf(r).includes("Đã dừng"));
  g = await httpReq("GET", "/index.html").catch((e) => ({ status: "ECONNREFUSED" }));
  ok("server no longer answers after stop", g.status === "ECONNREFUSED" || g.status === 0);

  /* ───────── 11. progress and exports ───────── */
  section("progress");
  const progDir = join(TEST_DIR, "prog");
  mkdirSync(progDir, { recursive: true });
  // a real player for the deck "Tổng 1 đến n" (title match) sits next to the progress file
  writeFileSync(join(progDir, "index.html"), readFileSync(indexPath, "utf8"), "utf8");
  const ev = (k, rating, prediction, output, t) => ({ v: 1, t, course: "Kiểm thử", lesson: "Bài 1", deck: "Tổng 1 đến n", slide: k, slideId: `mira-stop-${k}`, type: "predict", title: `Câu hỏi ${k}?`, prediction, rating, output });
  const progLines = [
    ev(1, "right", "3", "3", "2026-10-12T09:00:00+07:00"),
    ev(2, "different", "7", "4", "2026-10-12T09:01:00+07:00"),
    ev(3, "different", "(bỏ qua)", "5", "2026-10-12T09:02:00+07:00"),
    ev(2, "different", "8", "4", "2026-10-12T09:03:00+07:00"), // later attempt on stop 2 replaces the earlier one
    { v: 1, t: "2026-10-12T09:04:00+07:00", course: "Kiểm thử", lesson: "Bài 1", deck: "Tổng 1 đến n", slide: 16, slideId: "mira-complete", type: "complete", slides: 17, quiz: null, predictions: "1/4" },
    { v: 1, t: "2026-10-12T09:05:00+07:00", deck: "Một bộ khác", slide: 0, slideId: "s_quiz", type: "quiz", question: "q", chosen: [0], answer: [1], correct: false },
  ];
  writeFileSync(join(progDir, "progress.jsonl"), `${progLines.map((l) => JSON.stringify(l)).join("\n")}\nnot json at all\n`, "utf8");
  r = await call("mira_progress", { dir: progDir, hub: HUB });
  const progText = textOf(r);
  ok("progress summary counts per player", !r.isError && /Đã trả lời 2\/4: đúng 1, khác dự đoán 1, bỏ qua 1 · 50% đúng/.test(progText) && progText.includes("(đã đi hết)"), progText.split("\n").slice(0, 4).join(" | "));
  ok("progress ignores invalid lines and other tools' events", /Bỏ qua 1 dòng không hợp lệ/.test(progText) && !progText.includes("Một bộ khác"));
  const exportJson = JSON.parse(/```json\s*([\s\S]*?)```/.exec(progText)[1]);
  ok("errorLogEntries: one per real miss, with the specified why/fix/source", exportJson.errorLogEntries.length === 1 && exportJson.errorLogEntries[0].why === "Dự đoán sai khi dò code: Câu hỏi 2?" && /^Dò lại dòng \d+ và ghi quy tắc rút ra$/.test(exportJson.errorLogEntries[0].fix) && exportJson.errorLogEntries[0].source.endsWith("stop 2") && exportJson.errorLogEntries[0].prediction === "8" && exportJson.errorLogEntries[0].date === "2026-10-12" && exportJson.errorLogEntries[0].lesson === "Bài 1", JSON.stringify(exportJson.errorLogEntries[0]));
  ok("vegaCards: basic card with origin and mira tag", exportJson.vegaCards.length === 1 && exportJson.vegaCards[0].kind === "basic" && exportJson.vegaCards[0].tags[0] === "mira" && exportJson.vegaCards[0].origin.locator === "stop 2" && exportJson.vegaCards[0].origin.kind === "manual" && exportJson.vegaCards[0].back.includes("`4`"), JSON.stringify(exportJson.vegaCards[0]).slice(0, 200));
  let orionLib;
  try {
    orionLib = await import(pathToFileURL("D:/03_Development_Projects/ai_agents/orion_mcp/dist/orion.mjs").href);
  } catch {
    orionLib = null;
  }
  if (orionLib?.PolarisErrorLogExportSchema) {
    ok("exports validate against Orion's real schemas", orionLib.PolarisErrorLogExportSchema.safeParse(exportJson.errorLogEntries[0]).success && orionLib.VegaCardCandidateSchema.safeParse(exportJson.vegaCards[0]).success);
  } else {
    ok("exports validate against the local copies of Orion's schemas", lib.PolarisErrorLogExportSchema.safeParse(exportJson.errorLogEntries[0]).success && lib.VegaCardCandidateSchema.safeParse(exportJson.vegaCards[0]).success);
  }
  const summary = await lib.readProgress({ file: join(progDir, "progress.jsonl") });
  ok("progress from an exported file works too", summary.decks.length === 1 && summary.decks[0].right === 1);
  // to_vega
  r = await call("mira_progress", { dir: progDir, to_vega: true, hub: HUB });
  const inboxDir = join(HUB, ".vega", "inbox");
  const files1 = existsSync(inboxDir) ? readdirSync(inboxDir) : [];
  ok("to_vega writes exactly ONE jsonl file per call into <hub>/.vega/inbox/", files1.length === 1 && /^mira-\d{8}T\d{6}-[0-9a-f]{6}\.jsonl$/.test(files1[0]) && !files1.some((f) => f.endsWith(".tmp")), files1.join(","));
  const inboxLines1 = readFileSync(join(inboxDir, files1[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok("inbox lines: producer, key, origin mira-stop, href to #stop-k", inboxLines1.length === 2 && inboxLines1.every((l) => l.producer === "mira" && /^mira:tong-1-den-n:stop-[23]$/.test(l.key) && l.origin.kind === "mira-stop" && /^stop [23]$/.test(l.origin.locator) && l.origin.href.startsWith("file:///") && /#stop-[23]$/.test(l.origin.href) && l.origin.path.endsWith("index.html") && l.tags[0] === "mira" && l.kind === "basic"), JSON.stringify(inboxLines1[0]).slice(0, 260));
  ok("inbox lines validate against the vega-card-inbox.v1 contract", inboxLines1.every((l) => lib.validateInboxLine(l).length === 0), inboxLines1.map((l) => lib.validateInboxLine(l).join(";")).join("|"));
  ok("inbox card content: question with code context, real value and reason", inboxLines1.some((l) => l.front.includes("Câu hỏi 2?") && l.back.includes("`4`") && l.reason === "Dự đoán sai ở điểm dừng 2") && inboxLines1.some((l) => l.reason === "Bỏ qua điểm dừng 3"));
  ok("subject falls back to the course outside the hub", inboxLines1.every((l) => l.subject === "Kiểm thử"));
  await new Promise((rs) => setTimeout(rs, 1100));
  const cliOut = execFileSync(process.execPath, [DIST, "progress", progDir, "--to-vega", "--hub", HUB, "--json"], { encoding: "utf8", env: { ...process.env } });
  const files2 = readdirSync(inboxDir);
  const keys1 = inboxLines1.map((l) => l.key).sort();
  const lines2 = readFileSync(join(inboxDir, files2.find((f) => f !== files1[0])), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok("a second call writes a second file with the same stable keys (Vega dedupes by key)", files2.length === 2 && JSON.stringify(lines2.map((l) => l.key).sort()) === JSON.stringify(keys1), files2.join(","));
  ok("CLI progress --to-vega --json reports the inbox file", JSON.parse(cliOut).inbox.lines === 2 && JSON.parse(cliOut).decks[0].right === 1);
  // subject from the hub folder: a player under <hub>/<Subject>/...
  const subjDir = join(HUB, "Python_Master", "mira", "tri");
  mkdirSync(subjDir, { recursive: true });
  writeFileSync(join(subjDir, "index.html"), readFileSync(indexPath, "utf8"), "utf8");
  writeFileSync(join(subjDir, "progress.jsonl"), `${JSON.stringify(ev(2, "different", "9", "4", "2026-10-12T09:03:00+07:00"))}\n`, "utf8");
  const s3 = await lib.readProgress({ dir: subjDir, hub: HUB });
  ok("inbox subject = the first folder under the hub that holds the player", s3.inboxLines[0].subject === "Python_Master", s3.inboxLines[0]?.subject);
  r = await call("mira_progress", { dir: progDir });
  ok("mira_progress without to_vega writes nothing new", readdirSync(inboxDir).length === 2);

  // The real consumer: Vega's own validator and ingest (read-only use of its bundle, on the temp hub only).
  const vegaDist = "D:/03_Development_Projects/ai_agents/vega_mcp/dist/vega.mjs";
  if (existsSync(vegaDist)) {
    const vega = await import(pathToFileURL(vegaDist).href);
    const allLines = files2.flatMap((f) => readFileSync(join(inboxDir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
    const verdicts = allLines.map((l) => vega.validateInboxLine(l));
    ok("every inbox line passes Vega's real validateInboxLine", verdicts.every((x) => x.ok), verdicts.filter((x) => !x.ok).map((x) => x.errors.join(";")).join("|"));
    const preview = await vega.listInbox(HUB);
    ok("Vega previews both files: 2 new cards, 2 duplicates, 0 rejected", preview.pending_files === 2 && preview.would_create === 2 && preview.would_skip_duplicates === 2 && preview.would_reject === 0, preview.summary.split("\n").slice(0, 3).join(" | "));
    const ingest = await vega.ingestInbox(HUB);
    ok("Vega ingests the inbox: 2 cards created, duplicates skipped by key, nothing rejected", ingest.cards_created === 2 && ingest.duplicates_skipped === 2 && ingest.lines_rejected === 0 && ingest.created_cards.every((c) => /^mira:tong-1-den-n:stop-[23]$/.test(c.key)), ingest.summary.split("\n").slice(0, 5).join(" | "));
    const again = await vega.ingestInbox(HUB);
    ok("a second Vega ingest is a no-op (idempotent)", again.files_read === 0 && again.cards_created === 0);
    const doneFiles = existsSync(join(inboxDir, "done")) ? readdirSync(join(inboxDir, "done")) : [];
    ok("processed files moved to inbox/done/", doneFiles.length === 2);
    // a later Mira export of the same stops is still deduped against the cards Vega already holds
    await new Promise((rs) => setTimeout(rs, 1100));
    await call("mira_progress", { dir: progDir, to_vega: true, hub: HUB });
    const third = await vega.ingestInbox(HUB);
    ok("re-exporting the same misses later creates no new cards (key dedupe against existing cards)", third.cards_created === 0 && third.duplicates_skipped === 2, third.summary.split("\n").slice(0, 4).join(" | "));
  } else {
    console.log("skip Vega validation: vega dist not found");
  }
  r = await call("mira_progress", { dir: join(TEST_DIR, "empty_no_such") });
  ok("progress on a missing folder is an error", Boolean(r.isError));
  mkdirSync(join(TEST_DIR, "empty"), { recursive: true });
  r = await call("mira_progress", { dir: join(TEST_DIR, "empty") });
  ok("progress on a folder without progress.jsonl explains what to do", Boolean(r.isError) && /Chưa có tiến độ/.test(textOf(r)));

  /* ───────── 12. Orion lab (M3) ───────── */
  section("orion lab");
  const labDir = join(TEST_DIR, "lab1");
  mkdirSync(labDir, { recursive: true });
  writeFileSync(join(labDir, "lab.json"), JSON.stringify({ title: "Vòng lặp tổng", subject: "AMD AI Agents 101", module: "M1", language: "python", entry: "my_work.py", tests: { runner: "pytest" }, dod: ["x"], checks: {} }), "utf8");
  writeFileSync(join(labDir, "my_work.py"), `def running_total(values):\n    """running_total([1, 2, 3]) -> 6"""\n    acc = 0\n    for v in values:\n        acc += v\n    return acc\n`, "utf8");
  r = await call("mira_record", { lab: labDir, call: "running_total([1, 2, 3])", out_dir: join(TEST_DIR, "o_lab") });
  ok("record accepts lab and traces <lab>/<entry>", !r.isError && textOf(r).includes("my_work.py") && textOf(r).includes("Kết quả: 6"), textOf(r).split("\n")[0]);
  const labTrace = JSON.parse(readFileSync(join(TEST_DIR, "o_lab", "trace.json"), "utf8"));
  ok("trace remembers the lab (subject, module)", labTrace.lab.subject === "AMD AI Agents 101" && labTrace.lab.module === "M1" && labTrace.lab.title === "Vòng lặp tổng");
  const labBuild = await lib.buildPlayer({ title: "Lab tổng", trace: join(TEST_DIR, "o_lab", "trace.json"), stops: [{ at: { line: 5, hit: 2 }, ask: "acc sau lần 2?", expect: { expr: "acc" } }] });
  const labData = JSON.parse(/<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/.exec(readFileSync(labBuild.indexPath, "utf8"))[1]);
  ok("build defaults course = lab.subject and lesson = lab.module", labData.meta.course === "AMD AI Agents 101" && labData.meta.lesson === "M1", JSON.stringify([labData.meta.course, labData.meta.lesson]));
  const lp = bootPlayer(readFileSync(labBuild.indexPath, "utf8"), { embed: true });
  lp.click(lp.all((x) => x.tagName === "BUTTON" && x.textContent.includes("Điểm dừng tiếp theo"))[0]);
  lp.byClass("gate-input")[0].value = "3";
  lp.byClass("gate-input")[0].dispatchEvent(new FakeEvent("keydown", { key: "Enter" }));
  const labEvent = lp.messages.find((x) => x.m.kind === "event")?.m.event;
  ok("events carry course/lesson from lab.json", labEvent?.course === "AMD AI Agents 101" && labEvent?.lesson === "M1" && labEvent?.rating === "right", JSON.stringify(labEvent));
  smokeEvents.push(labEvent);
  r = await call("mira_drill", { lab: labDir, function: "running_total", out_dir: join(TEST_DIR, "d_lab") });
  ok("drill accepts lab and uses the docstring example", !r.isError && textOf(r).includes("running_total([1, 2, 3])"), textOf(r).split("\n").slice(0, 2).join(" | "));
  const emptyLab = join(TEST_DIR, "lab_nojson");
  mkdirSync(emptyLab, { recursive: true });
  r = await call("mira_record", { lab: emptyLab, script: true });
  ok("missing lab.json is a clear error", Boolean(r.isError) && /Không tìm thấy lab\.json/.test(textOf(r)));
  const lab2 = join(TEST_DIR, "lab_noentry");
  mkdirSync(lab2, { recursive: true });
  writeFileSync(join(lab2, "lab.json"), JSON.stringify({ title: "x", entry: "missing.py" }), "utf8");
  r = await call("mira_drill", { lab: lab2 });
  ok("missing entry file is a clear error", Boolean(r.isError) && /Tệp entry của lab không tồn tại/.test(textOf(r)));

  /* ───────── 13. SmartDrive hook (M4) ───────── */
  section("smartdrive hook");
  lib._resetSmartDriveState();
  const hookDir = join(TEST_DIR, "hooked");
  mkdirSync(hookDir, { recursive: true });
  process.env.MIRA_SMARTDRIVE = "off";
  process.env.MIRA_SMARTDRIVE_ROOT = tmpdir().slice(0, 2);
  process.env.MIRA_SMARTDRIVE_CMD = `"${process.execPath}" "${join(TEST_DIR, "fakehook.mjs")}" "${hookLog}"`;
  ok("hook is skipped when MIRA_SMARTDRIVE=off", lib.notifySmartDrive(hookDir) === false);
  await new Promise((rs) => setTimeout(rs, 600));
  ok("... and the fake command was not invoked", !existsSync(hookLog));
  delete process.env.MIRA_SMARTDRIVE;
  lib._resetSmartDriveState();
  ok("hook fires for a folder on the SmartDrive volume", lib.notifySmartDrive(hookDir) === true);
  for (let i = 0; i < 40 && !existsSync(hookLog); i++) await new Promise((rs) => setTimeout(rs, 100));
  const hookText = existsSync(hookLog) ? readFileSync(hookLog, "utf8") : "";
  ok("... as `update <dir> --quiet` via MIRA_SMARTDRIVE_CMD", hookText.trim() === `update ${resolve(hookDir)} --quiet`, hookText.trim());
  lib.notifySmartDrive(hookDir);
  lib.notifySmartDrive(hookDir);
  await new Promise((rs) => setTimeout(rs, 400));
  ok("repeated notifications are debounced (one call per 2 s window)", readFileSync(hookLog, "utf8").trim().split("\n").length === 1);
  process.env.MIRA_SMARTDRIVE_ROOT = "Q:";
  lib._resetSmartDriveState();
  ok("folders on another drive are skipped", lib.notifySmartDrive(hookDir) === false);
  process.env.MIRA_SMARTDRIVE = "off";
  delete process.env.MIRA_SMARTDRIVE_CMD;
  delete process.env.MIRA_SMARTDRIVE_ROOT;
  lib._resetSmartDriveState();

  /* ───────── 14. CLI ───────── */
  section("cli");
  const runCli = (args, opts = {}) => execFileSync(process.execPath, [DIST, ...args], { encoding: "utf8", env: { ...process.env }, ...opts });
  ok("CLI version prints 0.1.0", runCli(["version"]).trim() === "0.1.0");
  const help = runCli(["help"]);
  ok("CLI help lists the commands", ["record <file>", "build <spec.json>", "check <spec.json>", "drill <file>", "demo [out_dir]", "preview <dir>", "progress <dir|file>", "guide [topic]"].every((s) => help.includes(s)));
  const cliRec = JSON.parse(runCli(["record", toy, "--call", "triangular(4)", "--out", join(TEST_DIR, "c_rec"), "--json"]));
  ok("CLI record --json", cliRec.ok === true && cliRec.result === "10" && cliRec.lineEvents === 11 && existsSync(cliRec.tracePath), JSON.stringify(cliRec).slice(0, 100));
  const cliScript = JSON.parse(runCli(["record", toy, "--call", "triangular(4)", "--probe", "sq=total*total", "--focus", "triangular", "--max-steps", "5", "--out", join(TEST_DIR, "c_rec2"), "--json"]));
  ok("CLI record flags (probe, focus, max-steps)", cliScript.truncated === true && cliScript.lineEvents === 5 + 0);
  writeFileSync(join(TEST_DIR, "c_spec.json"), JSON.stringify({ title: "CLI", trace: join("c_rec", "trace.json"), viz: [], stops: [{ at: { line: 4, hit: 2 }, ask: "total?", expect: { expr: "total" } }] }), "utf8");
  const cliChk = JSON.parse(runCli(["check", join(TEST_DIR, "c_spec.json"), "--json"]));
  ok("CLI check --json resolves a relative trace next to the spec", cliChk.ok === true && cliChk.steps === 12 && cliChk.stops.length === 1, JSON.stringify(cliChk).slice(0, 160));
  const cliBuild = JSON.parse(runCli(["build", join(TEST_DIR, "c_spec.json"), "--json"]));
  ok("CLI build --json includes auroraSlide", cliBuild.ok === true && cliBuild.auroraSlide.type === "trace" && cliBuild.auroraSlide.eyebrow === "Dò code" && existsSync(cliBuild.indexPath));
  writeFileSync(join(TEST_DIR, "c_bad.json"), JSON.stringify({ title: "bad", trace: join(TEST_DIR, "c_rec", "trace.json"), stops: [{ at: { line: 77 }, ask: "x", expect: { expr: "total" } }] }), "utf8");
  const badRun = spawnSync(process.execPath, [DIST, "check", join(TEST_DIR, "c_bad.json"), "--json"], { encoding: "utf8" });
  ok("CLI check exits non-zero on an invalid spec", badRun.status === 1 && JSON.parse(badRun.stdout).errors.length === 1);
  const cliDrill = JSON.parse(runCli(["drill", join(FX, "scaler.py"), "scale_all", "--out", join(TEST_DIR, "c_drill"), "--stops", "3", "--json"]));
  ok("CLI drill --json", cliDrill.ok === true && cliDrill.stops.length === 3 && cliDrill.call === "scale_all([1, 2, 3], 2)", JSON.stringify(cliDrill).slice(0, 140));
  const refusal = spawnSync(process.execPath, [DIST, "drill", join(FX, "scaler.py"), "broken", "--call", "broken(1)", "--json"], { encoding: "utf8" });
  ok("CLI drill refuses placeholders with exit 1", refusal.status === 1 && JSON.parse(refusal.stdout).text.includes("Hoàn thành chỗ trống trước khi dò code."));
  const cliGuide = JSON.parse(runCli(["guide", "viz", "--json"]));
  ok("CLI guide --json", cliGuide.topic === "viz" && cliGuide.content.includes("statevector"));
  const cliDemo = JSON.parse(runCli(["demo", join(TEST_DIR, "demo_cli"), "--json"]));
  ok("CLI demo --json", cliDemo.ok === true && cliDemo.astar.visited < cliDemo.dijkstra.visited && existsSync(cliDemo.hubPath));
  const unknown = spawnSync(process.execPath, [DIST, "frobnicate"], { encoding: "utf8" });
  ok("CLI unknown command exits 1", unknown.status === 1);

  /* ───────── 15. contract validation of every event the player emitted (M5) ───────── */
  section("progress event contract");
  ok("collected events from the player runs", smokeEvents.length >= 6, String(smokeEvents.length));
  ok("every emitted event satisfies aurora-progress-event.v1 (local replica)", smokeEvents.every((e) => lib.validateProgressEvent(e).length === 0), smokeEvents.map((e) => lib.validateProgressEvent(e).join(";")).filter(Boolean).join("|"));
  ok(
    "predict events: slideId mira-stop-<k>, title = the question, deck = spec title",
    smokeEvents.filter((e) => e.type === "predict").every((e) => /^mira-stop-\d+$/.test(e.slideId) && e.title.length > 0 && e.title.length <= 200 && e.deck.length > 0 && (e.rating === "right" || e.rating === "different") && e.output.length <= 300),
  );
  const evFile = join(TEST_DIR, "events.jsonl");
  writeFileSync(evFile, `${smokeEvents.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  const constellation = "D:/03_Development_Projects/ai_agents/constellation_mcp/dist/constellation.mjs";
  if (existsSync(constellation)) {
    const cr = spawnSync(process.execPath, [constellation, "contracts", "validate", "aurora-progress-event.v1", evFile], { encoding: "utf8" });
    ok("constellation contracts validate prints OK for the produced events", cr.status === 0 && /^OK:/.test(cr.stdout.trim()), cr.stdout.trim().slice(0, 160) || cr.stderr.slice(0, 160));
    const bogus = join(TEST_DIR, "bogus.jsonl");
    writeFileSync(bogus, `${JSON.stringify({ ...smokeEvents[0], rating: "nope" })}\n`, "utf8");
    const cb = spawnSync(process.execPath, [constellation, "contracts", "validate", "aurora-progress-event.v1", bogus], { encoding: "utf8" });
    ok("... and the validator really rejects a bad event (sanity)", cb.status !== 0);
  } else {
    console.log("skip constellation validation: dist not found");
  }

  /* ───────── 16. repository hygiene ───────── */
  section("hygiene");
  const srcDirs = ["src", "src/player", "src/player/ui", "src/player/viz", "guide", "scripts", "."];
  const docFiles = ["README.md", "README.vi.md", "PLAN.md", "guide/GUIDE.md"];
  let emojiHits = [];
  for (const d of srcDirs) {
    const full = join(ROOT, d);
    for (const name of readdirSync(full)) {
      const p = join(full, name);
      if (!statSync(p).isFile() || !/\.(ts|mjs|md|css|json)$/.test(name)) continue;
      if (EMOJI.test(readFileSync(p, "utf8"))) emojiHits.push(`${d}/${name}`);
    }
  }
  ok("no emoji in sources and docs", emojiHits.length === 0, emojiHits.join(", "));
  ok("docs exist", docFiles.every((f) => existsSync(join(ROOT, f))) && readFileSync(join(ROOT, "README.md"), "utf8").split("\n")[0].includes("README.vi.md"));
  ok("no node_modules in the project", !existsSync(join(ROOT, "node_modules")));
  ok("no __pycache__ anywhere in the test fixtures", !existsSync(join(FX, "__pycache__")) && !existsSync(join(TEST_DIR, "demo", "__pycache__")) && !existsSync(join(labDir, "__pycache__")));
} catch (e) {
  failed++;
  console.log(`FAIL unexpected exception  (${e instanceof Error ? e.stack : String(e)})`);
} finally {
  await client.close();
  try {
    lib.stopAllPreviews?.();
  } catch {
    // ignore
  }
  if (!process.env.MIRA_E2E_KEEP) {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  } else {
    console.log(`kept fixtures in ${TEST_DIR}`);
  }
}

console.log("\n-------------------------------------------");
console.log(`${passed} ok, ${failed} FAIL`);
if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) failed.`);
  process.exit(1);
} else {
  console.log("ALL E2E CHECKS PASSED!");
  process.exit(0);
}
