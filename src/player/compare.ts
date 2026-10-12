/**
 * Prediction comparison. The learner types a Python-like literal; we parse it leniently and compare it with the
 * recorded value:
 *   - ints / floats compare numerically within a relative tolerance (default 1e-9): 3 equals 3.0
 *   - True / False / None; quoted strings; bare words count as strings; strings are trimmed
 *   - list and tuple are equal when their items are equal; set and dict ignore order
 * Pure functions, used by the player and unit-tested in Node.
 */
import { isPlainObject, tagOf } from "./delta.js";
import type { Val } from "./types.js";
import { entriesOf, itemsOf, ndarrayOf, numOf, numOfLoose, pyRepr } from "./values.js";

export type PyVal = null | boolean | number | bigint | string | PyList | PyTuple | PySet | PyDict | PyComplex;
export interface PyList {
  t: "list";
  v: PyVal[];
}
export interface PyTuple {
  t: "tuple";
  v: PyVal[];
}
export interface PySet {
  t: "set";
  v: PyVal[];
}
export interface PyDict {
  t: "dict";
  v: Array<[PyVal, PyVal]>;
}
export interface PyComplex {
  t: "complex";
  re: number;
  im: number;
}

export type ParseResult = { ok: true; value: PyVal } | { ok: false; error: string };

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  fail(msg: string): never {
    throw new Error(`${msg} (vị trí ${this.i})`);
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] as string)) this.i++;
  }

  private peek(): string {
    return this.s[this.i] ?? "";
  }

  private eat(ch: string): boolean {
    this.ws();
    if (this.s[this.i] === ch) {
      this.i++;
      return true;
    }
    return false;
  }

  parseTop(): PyVal {
    const first = this.parseExpr();
    this.ws();
    if (this.peek() === ",") {
      const items: PyVal[] = [first];
      while (this.eat(",")) {
        this.ws();
        if (this.i >= this.s.length) break;
        items.push(this.parseExpr());
      }
      this.ws();
      if (this.i < this.s.length) this.fail("còn ký tự thừa");
      return { t: "tuple", v: items };
    }
    if (this.i < this.s.length) this.fail("còn ký tự thừa");
    return first;
  }

  private parseExpr(): PyVal {
    this.ws();
    const c = this.peek();
    if (c === "") this.fail("thiếu giá trị");
    if (c === "[") return this.parseSeq("[", "]", "list");
    if (c === "(") return this.parseParen();
    if (c === "{") return this.parseBrace();
    if (c === "'" || c === '"') return this.parseString("");
    if (/[A-Za-z_]/.test(c)) return this.parseWord();
    return this.parseNumber();
  }

  private parseSeq(open: string, close: string, kind: "list"): PyVal {
    this.i++; // open
    const items: PyVal[] = [];
    for (;;) {
      this.ws();
      if (this.peek() === close) {
        this.i++;
        break;
      }
      if (this.i >= this.s.length) this.fail(`thiếu ${close}`);
      items.push(this.parseExpr());
      this.ws();
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== close) this.fail(`thiếu ${close}`);
    }
    void open;
    return { t: kind, v: items };
  }

  private parseParen(): PyVal {
    this.i++; // (
    const items: PyVal[] = [];
    let trailingComma = false;
    for (;;) {
      this.ws();
      if (this.peek() === ")") {
        this.i++;
        break;
      }
      if (this.i >= this.s.length) this.fail("thiếu )");
      items.push(this.parseExpr());
      trailingComma = false;
      this.ws();
      if (this.peek() === ",") {
        this.i++;
        trailingComma = true;
      } else if (this.peek() !== ")") {
        this.fail("thiếu )");
      }
    }
    if (items.length === 1 && !trailingComma) return items[0] as PyVal; // grouping, e.g. (1+2j)
    return { t: "tuple", v: items };
  }

  private parseBrace(): PyVal {
    this.i++; // {
    this.ws();
    if (this.peek() === "}") {
      this.i++;
      return { t: "dict", v: [] };
    }
    const first = this.parseExpr();
    this.ws();
    if (this.peek() === ":") {
      this.i++;
      const pairs: Array<[PyVal, PyVal]> = [[first, this.parseExpr()]];
      for (;;) {
        this.ws();
        if (this.peek() === ",") this.i++;
        this.ws();
        if (this.peek() === "}") {
          this.i++;
          break;
        }
        if (this.i >= this.s.length) this.fail("thiếu }");
        const k = this.parseExpr();
        this.ws();
        if (this.peek() !== ":") this.fail("thiếu :");
        this.i++;
        pairs.push([k, this.parseExpr()]);
      }
      return { t: "dict", v: pairs };
    }
    const items: PyVal[] = [first];
    for (;;) {
      this.ws();
      if (this.peek() === ",") this.i++;
      this.ws();
      if (this.peek() === "}") {
        this.i++;
        break;
      }
      if (this.i >= this.s.length) this.fail("thiếu }");
      items.push(this.parseExpr());
    }
    return { t: "set", v: items };
  }

  private parseString(prefix: string): string {
    const q = this.peek();
    const triple = this.s.startsWith(q.repeat(3), this.i);
    const raw = /r/i.test(prefix);
    this.i += triple ? 3 : 1;
    let out = "";
    for (;;) {
      if (this.i >= this.s.length) this.fail("chuỗi chưa đóng");
      const ch = this.s[this.i] as string;
      if (triple ? this.s.startsWith(q.repeat(3), this.i) : ch === q) {
        this.i += triple ? 3 : 1;
        return out;
      }
      if (ch === "\\" && !raw) {
        const nx = this.s[this.i + 1] ?? "";
        this.i += 2;
        if (nx === "n") out += "\n";
        else if (nx === "t") out += "\t";
        else if (nx === "r") out += "\r";
        else if (nx === "0") out += "\0";
        else if (nx === "x") {
          out += String.fromCharCode(Number.parseInt(this.s.slice(this.i, this.i + 2), 16));
          this.i += 2;
        } else if (nx === "u") {
          out += String.fromCharCode(Number.parseInt(this.s.slice(this.i, this.i + 4), 16));
          this.i += 4;
        } else out += nx;
        continue;
      }
      out += ch;
      this.i++;
    }
  }

  private parseWord(): PyVal {
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(this.s.slice(this.i));
    const word = (m?.[0] ?? "") as string;
    const after = this.s[this.i + word.length] ?? "";
    // string prefixes: r"..", b"..", u"..", f".."
    if ((after === "'" || after === '"') && /^[rRbBuUfF]{1,2}$/.test(word)) {
      this.i += word.length;
      return this.parseString(word);
    }
    this.i += word.length;
    const lower = word.toLowerCase();
    if (this.peek() === "(") {
      return this.parseCall(word);
    }
    if (word === "None" || lower === "none" || lower === "null") return null;
    if (word === "True" || lower === "true") return true;
    if (word === "False" || lower === "false") return false;
    if (lower === "nan") return Number.NaN;
    if (lower === "inf" || lower === "infinity") return Infinity;
    this.fail(`không hiểu "${word}"`);
  }

  private parseCall(name: string): PyVal {
    this.i++; // (
    const args: PyVal[] = [];
    for (;;) {
      this.ws();
      if (this.peek() === ")") {
        this.i++;
        break;
      }
      if (this.i >= this.s.length) this.fail("thiếu )");
      // keyword args such as dtype=float are ignored
      const kw = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(this.s.slice(this.i));
      if (kw) {
        this.i += kw[0].length;
        this.parseExpr();
      } else {
        args.push(this.parseExpr());
      }
      this.ws();
      if (this.peek() === ",") this.i++;
      else if (this.peek() !== ")") this.fail("thiếu )");
    }
    const base = name.split(".").pop() as string;
    const first = args[0];
    const listish = (v: PyVal | undefined): PyVal[] => {
      if (v === undefined) return [];
      if (typeof v === "object" && v !== null && "v" in v && Array.isArray(v.v)) {
        return v.t === "dict" ? (v.v as Array<[PyVal, PyVal]>).map((p) => p[0]) : (v.v as PyVal[]);
      }
      if (typeof v === "string") return [...v];
      return [v];
    };
    switch (base) {
      case "set":
      case "frozenset":
        return { t: "set", v: listish(first) };
      case "list":
        return { t: "list", v: listish(first) };
      case "tuple":
        return { t: "tuple", v: listish(first) };
      case "array":
      case "asarray":
        return first ?? { t: "list", v: [] };
      case "float":
        return typeof first === "number" ? first : typeof first === "string" ? Number.parseFloat(first) : (first as PyVal);
      case "int":
        return typeof first === "number" ? Math.trunc(first) : typeof first === "string" ? Number.parseInt(first, 10) : (first as PyVal);
      case "complex":
        return { t: "complex", re: Number(args[0] ?? 0), im: Number(args[1] ?? 0) };
      case "dict":
        return { t: "dict", v: [] };
      default:
        return this.fail(`không hiểu ${name}(...)`);
    }
  }

  private num(): { value: number | bigint; imag: boolean } {
    const rest = this.s.slice(this.i);
    const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[jJ]?/.exec(rest);
    if (!m) this.fail("không hiểu giá trị");
    let text = m[0];
    this.i += text.length;
    const imag = /[jJ]$/.test(text);
    if (imag) text = text.slice(0, -1);
    text = text.replace(/_/g, "");
    if (/^0[xXbBoO]/.test(text)) return { value: BigInt(text), imag };
    if (/^\d+$/.test(text)) {
      const asNumber = Number(text);
      return { value: Number.isSafeInteger(asNumber) ? asNumber : BigInt(text), imag };
    }
    return { value: Number.parseFloat(text), imag };
  }

  private parseNumber(): PyVal {
    this.ws();
    let sign = 1;
    while (this.peek() === "-" || this.peek() === "+") {
      if (this.peek() === "-") sign = -sign;
      this.i++;
      this.ws();
    }
    if (/[A-Za-z]/.test(this.peek())) {
      const w = this.parseWord();
      if (typeof w === "number") return sign * w;
      return this.fail("sau dấu +/- cần một số");
    }
    const a = this.num();
    const aval = typeof a.value === "bigint" ? a.value : a.value;
    if (a.imag) return { t: "complex", re: 0, im: sign * Number(aval) };
    // a+bj / a-bj
    const save = this.i;
    this.ws();
    if (this.peek() === "+" || this.peek() === "-") {
      const bsign = this.peek() === "-" ? -1 : 1;
      this.i++;
      this.ws();
      if (/[\d.]/.test(this.peek())) {
        const b = this.num();
        if (b.imag) return { t: "complex", re: sign * Number(aval), im: bsign * Number(b.value) };
      }
    }
    this.i = save;
    if (typeof aval === "bigint") return sign < 0 ? -aval : aval;
    return sign * aval;
  }
}

/** Parses a Python-like literal typed by the learner (an implicit tuple "1, 2" is accepted). */
export function parsePy(text: string): ParseResult {
  const s = text.trim();
  if (s === "") return { ok: false, error: "trống" };
  try {
    return { ok: true, value: new Parser(s).parseTop() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Converts a recorded value to a comparable PyVal. */
export function fromVal(v: Val | undefined): PyVal {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return { t: "list", v: v.map(fromVal) };
  if (isPlainObject(v)) {
    switch (tagOf(v)) {
      case "__float__":
      case "__int__": {
        if (typeof v.__int__ === "string") {
          const n = Number(v.__int__);
          return Number.isSafeInteger(n) ? n : BigInt(v.__int__);
        }
        return numOf(v) ?? Number.NaN;
      }
      case "__str__":
        return String(v.__str__);
      case "__list__":
        return { t: "list", v: ((v.__list__ as Val[]) ?? []).map(fromVal) };
      case "__tuple__":
        return { t: "tuple", v: ((v.__tuple__ as Val[]) ?? []).map(fromVal) };
      case "__set__":
        return { t: "set", v: ((v.__set__ as Val[]) ?? []).map(fromVal) };
      case "__dict__":
      case undefined:
        return { t: "dict", v: (entriesOf(v) ?? []).map(([k, x]) => [fromVal(k), fromVal(x)] as [PyVal, PyVal]) };
      case "__complex__": {
        const c = v.__complex__ as Val[];
        return { t: "complex", re: numOfLoose(c[0]), im: numOfLoose(c[1]) };
      }
      case "__ndarray__": {
        const nd = ndarrayOf(v);
        if (nd?.data) return ndToPy(nd.shape, nd.data, nd.dtype.startsWith("complex"));
        return pyRepr(v);
      }
      default:
        return pyRepr(v);
    }
  }
  return null;
}

function ndToPy(shape: number[], data: Val[], complex: boolean): PyVal {
  const leaf = (x: Val | undefined): PyVal =>
    complex && Array.isArray(x) ? { t: "complex", re: numOfLoose(x[0]), im: numOfLoose(x[1]) } : typeof x === "boolean" ? x : numOfLoose(x);
  if (shape.length <= 1) return { t: "list", v: data.map(leaf) };
  const rows = shape[0] ?? 0;
  const stride = shape.slice(1).reduce((a, b) => a * b, 1);
  const out: PyVal[] = [];
  for (let r = 0; r < rows; r++) out.push(ndToPy(shape.slice(1), data.slice(r * stride, (r + 1) * stride), complex));
  return { t: "list", v: out };
}

function isSeq(x: PyVal): x is PyList | PyTuple {
  return typeof x === "object" && x !== null && (x.t === "list" || x.t === "tuple");
}
function isSet(x: PyVal): x is PySet {
  return typeof x === "object" && x !== null && x.t === "set";
}
function isDict(x: PyVal): x is PyDict {
  return typeof x === "object" && x !== null && x.t === "dict";
}
function isComplex(x: PyVal): x is PyComplex {
  return typeof x === "object" && x !== null && x.t === "complex";
}

function numEq(a: number, b: number, tol: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

export function valuesEqual(a: PyVal, b: PyVal, tol = 1e-9): boolean {
  if (typeof a === "number" && typeof b === "number") return numEq(a, b, tol);
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (typeof a === "bigint" && typeof b === "bigint") return a === b;
    const big = typeof a === "bigint" ? a : (b as bigint);
    const other = typeof a === "bigint" ? b : a;
    if (typeof other === "number" && Number.isInteger(other)) return BigInt(other) === big;
    return false;
  }
  if (isComplex(a) || isComplex(b)) {
    const ca = isComplex(a) ? a : typeof a === "number" ? ({ t: "complex", re: a, im: 0 } as PyComplex) : undefined;
    const cb = isComplex(b) ? b : typeof b === "number" ? ({ t: "complex", re: b, im: 0 } as PyComplex) : undefined;
    return !!ca && !!cb && numEq(ca.re, cb.re, tol) && numEq(ca.im, cb.im, tol);
  }
  if (a === null || b === null) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "string" || typeof b === "string") return typeof a === "string" && typeof b === "string" && a.trim() === b.trim();
  if (isSeq(a) && isSeq(b)) {
    return a.v.length === b.v.length && a.v.every((x, i) => valuesEqual(x, b.v[i] as PyVal, tol));
  }
  if (isSet(a) && isSet(b)) {
    if (a.v.length !== b.v.length) return false;
    const used = new Set<number>();
    return a.v.every((x) => {
      const j = b.v.findIndex((y, idx) => !used.has(idx) && valuesEqual(x, y, tol));
      if (j < 0) return false;
      used.add(j);
      return true;
    });
  }
  if (isDict(a) && isDict(b)) {
    if (a.v.length !== b.v.length) return false;
    return a.v.every(([k, x]) => {
      const hit = b.v.find(([k2]) => valuesEqual(k, k2, tol));
      return hit !== undefined && valuesEqual(x, hit[1], tol);
    });
  }
  return false;
}

export interface Comparison {
  right: boolean;
  /** how the typed text was understood (shown when it differs) */
  parsed?: string;
}

/**
 * Compares the learner's typed prediction with a recorded value.
 * When the expected value is a string, the raw (trimmed) text also counts: `abc` equals 'abc' and `3` equals '3'.
 */
export function comparePrediction(input: string, expected: Val | undefined, tolerance = 1e-9): Comparison {
  const exp = fromVal(expected);
  const raw = input.trim();
  const parsed = parsePy(raw);
  if (parsed.ok && valuesEqual(parsed.value, exp, tolerance)) return { right: true };
  if (typeof exp === "string") {
    const stripped = raw.replace(/^(['"])(.*)\1$/s, "$2");
    if (raw === exp.trim() || stripped === exp.trim()) return { right: true };
  }
  return { right: false };
}

/** Compares two recorded/typed values directly (used by tests and by choice stops). */
export function sameValue(a: Val | undefined, b: Val | undefined, tolerance = 1e-9): boolean {
  return valuesEqual(fromVal(a), fromVal(b), tolerance);
}

export function itemCount(v: Val | undefined): number {
  return itemsOf(v)?.length ?? 0;
}
