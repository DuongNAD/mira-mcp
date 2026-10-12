/**
 * Helpers for serialized values (see types.ts): decoding tags, Python-style display, list/dict/pair accessors.
 * Pure functions shared by the Node side and the player.
 */
import { isPlainObject, tagOf } from "./delta.js";
import type { Val } from "./types.js";

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Python repr() of a float given as a JS number. */
export function pyFloat(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const a = Math.abs(x);
  if (a >= 1e16 || a < 1e-4) {
    const s = x.toExponential();
    const [m, e] = s.split("e") as [string, string];
    const sign = e.startsWith("-") ? "-" : "+";
    const digits = e.replace(/^[+-]/, "").padStart(2, "0");
    return `${m}e${sign}${digits}`;
  }
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** Python repr() of a str. */
export function pyQuote(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === quote) out += `\\${quote}`;
    else out += ch;
  }
  return quote + out + quote;
}

function floatFromString(s: string): number {
  if (s === "nan") return Number.NaN;
  if (s === "inf") return Infinity;
  if (s === "-inf") return -Infinity;
  return Number.parseFloat(s);
}

export function isFloatTag(v: unknown): v is { __float__: string } {
  return isPlainObject(v) && typeof v.__float__ === "string";
}

/** Numeric value of an int / float / big-int / float tag (booleans are not numbers here). */
export function numOf(v: Val | undefined): number | undefined {
  if (typeof v === "number") return v;
  if (isPlainObject(v)) {
    if (typeof v.__float__ === "string") return floatFromString(v.__float__);
    if (typeof v.__int__ === "string") return Number(v.__int__);
  }
  return undefined;
}

export function isNumVal(v: Val | undefined): boolean {
  return numOf(v) !== undefined;
}

/** True for values that are Python floats (JS number with a fraction, or a float tag). */
export function isFloatVal(v: Val | undefined): boolean {
  return isFloatTag(v) || (typeof v === "number" && !Number.isInteger(v));
}

/** Items of a list-like value: list, truncated list, tuple, set, deque. Undefined for anything else. */
export function itemsOf(v: Val | undefined): Val[] | undefined {
  if (Array.isArray(v)) return v;
  if (isPlainObject(v)) {
    if (Array.isArray(v.__list__)) return v.__list__ as Val[];
    if (Array.isArray(v.__tuple__)) return v.__tuple__ as Val[];
    if (Array.isArray(v.__set__)) return v.__set__ as Val[];
  }
  return undefined;
}

/** Entries of a dict value (plain JSON object or `__dict__` pair list). */
export function entriesOf(v: Val | undefined): Array<[Val, Val]> | undefined {
  if (!isPlainObject(v)) return undefined;
  const tag = tagOf(v);
  if (tag === "__dict__") {
    const pairs = v.__dict__;
    if (!Array.isArray(pairs)) return undefined;
    return (pairs as Val[][]).map((p) => [p[0] as Val, p[1] as Val] as [Val, Val]);
  }
  if (tag !== undefined) return undefined;
  return Object.keys(v).map((k) => [k, v[k] as Val] as [Val, Val]);
}

export function isDictVal(v: Val | undefined): boolean {
  return entriesOf(v) !== undefined;
}

/** len() of a serialized value, honouring the stored full length of truncated containers. */
export function lengthOf(v: Val | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (isPlainObject(v)) {
    const tag = tagOf(v);
    const n = typeof v.n === "number" ? v.n : undefined;
    switch (tag) {
      case "__str__":
        return n;
      case "__list__":
      case "__tuple__":
      case "__set__":
        return n ?? (Array.isArray(v[tag]) ? (v[tag] as Val[]).length : undefined);
      case "__dict__":
        return n ?? (Array.isArray(v.__dict__) ? (v.__dict__ as Val[]).length : undefined);
      case "__ndarray__": {
        const nd = v.__ndarray__;
        if (isPlainObject(nd) && Array.isArray(nd.shape) && typeof nd.shape[0] === "number") return nd.shape[0];
        return undefined;
      }
      case undefined:
        return Object.keys(v).length;
      default:
        return undefined;
    }
  }
  return undefined;
}

/** [row, col] of a 2-element numeric list/tuple. */
export function pairOf(v: Val | undefined): [number, number] | undefined {
  const items = itemsOf(v);
  if (!items || items.length !== 2) return undefined;
  const a = numOf(items[0]);
  const b = numOf(items[1]);
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return [a, b];
}

/**
 * Grid cell of an element: a (r, c) pair itself, or a heap entry such as (f, g, (r, c)) whose last item is a pair.
 */
export function cellOf(v: Val | undefined): [number, number] | undefined {
  const direct = pairOf(v);
  if (direct) return direct;
  const items = itemsOf(v);
  if (!items || items.length === 0) return undefined;
  return pairOf(items[items.length - 1]);
}

/** Flat numeric data of a numpy array value reshaped to nested arrays (complex stays [re, im]). */
export function ndarrayOf(v: Val | undefined): { shape: number[]; dtype: string; data?: Val[] } | undefined {
  if (!isPlainObject(v) || !isPlainObject(v.__ndarray__)) return undefined;
  const nd = v.__ndarray__;
  const shape = Array.isArray(nd.shape) ? (nd.shape as Val[]).filter((x): x is number => typeof x === "number") : [];
  const dtype = typeof nd.dtype === "string" ? nd.dtype : "";
  const data = Array.isArray(nd.data) ? (nd.data as Val[]) : undefined;
  return data ? { shape, dtype, data } : { shape, dtype };
}

/** A numpy array as nested JSON lists (complex entries become complex values); undefined without data. */
export function ndToVal(v: Val | undefined): Val | undefined {
  const nd = ndarrayOf(v);
  if (!nd?.data) return undefined;
  const complex = nd.dtype.startsWith("complex");
  const leaf = (x: Val | undefined): Val => (complex && Array.isArray(x) ? { __complex__: [x[0] ?? 0, x[1] ?? 0] } : (x ?? null));
  const build = (shape: number[], data: Val[]): Val => {
    if (shape.length <= 1) return data.map(leaf);
    const rows = shape[0] ?? 0;
    const stride = shape.slice(1).reduce((a, b) => a * b, 1);
    const out: Val[] = [];
    for (let r = 0; r < rows; r++) out.push(build(shape.slice(1), data.slice(r * stride, (r + 1) * stride)));
    return out;
  };
  return build(nd.shape, nd.data);
}

function fmtNum(x: number): string {
  return Number.isInteger(x) ? String(x) : pyFloat(x);
}

export function fmtComplex(re: number, im: number): string {
  const imNeg = im < 0 || Object.is(im, -0);
  if (re === 0 && !Object.is(re, -0)) return `${fmtNum(im)}j`;
  return `(${fmtNum(re)}${imNeg ? "-" : "+"}${fmtNum(Math.abs(im))}j)`;
}

/** Complex numbers of a statevector-like value: list of complex, list of reals, or numpy array. */
export function complexListOf(v: Val | undefined): Array<[number, number]> | undefined {
  const nd = ndarrayOf(v);
  if (nd && nd.data) {
    const isComplex = nd.dtype.startsWith("complex");
    const out: Array<[number, number]> = [];
    for (const x of nd.data) {
      if (isComplex) {
        if (!Array.isArray(x)) return undefined;
        out.push([numOfLoose(x[0]), numOfLoose(x[1])]);
      } else {
        out.push([numOfLoose(x), 0]);
      }
    }
    return out;
  }
  const items = itemsOf(v);
  if (!items) return undefined;
  const out: Array<[number, number]> = [];
  for (const x of items) {
    if (isPlainObject(x) && Array.isArray(x.__complex__)) {
      out.push([numOfLoose((x.__complex__ as Val[])[0]), numOfLoose((x.__complex__ as Val[])[1])]);
    } else {
      const n = numOf(x);
      if (n === undefined) return undefined;
      out.push([n, 0]);
    }
  }
  return out;
}

/** Number from a plain JSON number or one of the special float strings used inside ndarray data. */
export function numOfLoose(v: Val | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return floatFromString(v);
  return numOf(v) ?? Number.NaN;
}

function reprDict(entries: Array<[Val, Val]>, maxItems: number, depth: number): string {
  const shown = entries.slice(0, maxItems).map(([k, x]) => `${reprInner(k, maxItems, depth + 1)}: ${reprInner(x, maxItems, depth + 1)}`);
  if (entries.length > maxItems) shown.push("...");
  return `{${shown.join(", ")}}`;
}

function reprInner(v: Val | undefined, maxItems: number, depth: number): string {
  if (v === undefined) return "";
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloat(v);
  if (typeof v === "string") return pyQuote(v);
  if (depth > 6) return "...";
  if (Array.isArray(v)) {
    const shown = v.slice(0, maxItems).map((x) => reprInner(x, maxItems, depth + 1));
    if (v.length > maxItems) shown.push("...");
    return `[${shown.join(", ")}]`;
  }
  const tag = tagOf(v);
  switch (tag) {
    case "__float__":
      return String(v.__float__);
    case "__int__":
      return String(v.__int__);
    case "__str__": {
      const n = typeof v.n === "number" ? v.n : undefined;
      return `${pyQuote(String(v.__str__))}...${n !== undefined ? ` (${n} ký tự)` : ""}`;
    }
    case "__list__": {
      const items = (v.__list__ as Val[]).slice(0, maxItems).map((x) => reprInner(x, maxItems, depth + 1));
      const n = typeof v.n === "number" ? v.n : undefined;
      return `[${items.join(", ")}, ...${n !== undefined ? ` (${n})` : ""}]`;
    }
    case "__tuple__": {
      const arr = v.__tuple__ as Val[];
      const items = arr.slice(0, maxItems).map((x) => reprInner(x, maxItems, depth + 1));
      if (arr.length > maxItems) items.push("...");
      return items.length === 1 && arr.length === 1 ? `(${items[0]},)` : `(${items.join(", ")})`;
    }
    case "__set__": {
      const arr = v.__set__ as Val[];
      if (arr.length === 0) return v.frozen ? "frozenset()" : "set()";
      const items = arr.slice(0, maxItems).map((x) => reprInner(x, maxItems, depth + 1));
      if (arr.length > maxItems) items.push("...");
      const body = `{${items.join(", ")}}`;
      return v.frozen ? `frozenset(${body})` : body;
    }
    case "__dict__": {
      const entries = entriesOf(v) ?? [];
      return reprDict(entries, maxItems, depth);
    }
    case "__complex__": {
      const c = v.__complex__ as Val[];
      return fmtComplex(numOfLoose(c[0]), numOfLoose(c[1]));
    }
    case "__ndarray__": {
      const nd = ndarrayOf(v);
      if (!nd) return "array(...)";
      if (nd.data) return `array(${reprNd(nd.shape, nd.data, nd.dtype)})`;
      return `array(shape=${JSON.stringify(nd.shape)}, dtype=${nd.dtype})`;
    }
    case "__obj__": {
      const attrs = isPlainObject(v.attrs) ? v.attrs : {};
      const parts = Object.keys(attrs)
        .slice(0, maxItems)
        .map((k) => `${k}=${reprInner(attrs[k], maxItems, depth + 1)}`);
      return `${String(v.__obj__)}(${parts.join(", ")})`;
    }
    case "__repr__":
      return String(v.__repr__);
    default:
      return reprDict(entriesOf(v) ?? [], maxItems, depth);
  }
}

function reprNd(shape: number[], data: Val[], dtype: string): string {
  const complex = dtype.startsWith("complex");
  const isFloat = dtype.startsWith("float");
  const cell = (x: Val | undefined): string => {
    if (complex && Array.isArray(x)) return fmtComplex(numOfLoose(x[0]), numOfLoose(x[1]));
    if (typeof x === "boolean") return x ? "True" : "False";
    const n = numOfLoose(x);
    if (isFloat) return pyFloat(n);
    return Number.isInteger(n) ? String(n) : pyFloat(n);
  };
  if (shape.length <= 1) return `[${data.slice(0, 60).map(cell).join(", ")}${data.length > 60 ? ", ..." : ""}]`;
  const rows = shape[0] ?? 0;
  const stride = shape.slice(1).reduce((a, b) => a * b, 1);
  const parts: string[] = [];
  for (let r = 0; r < Math.min(rows, 12); r++) {
    parts.push(reprNd(shape.slice(1), data.slice(r * stride, (r + 1) * stride), dtype));
  }
  if (rows > 12) parts.push("...");
  return `[${parts.join(", ")}]`;
}

/** Python-style display of a serialized value; truncated to maxLen characters with an ellipsis. */
export function pyRepr(v: Val | undefined, maxLen = 200, maxItems = 24): string {
  const s = reprInner(v, maxItems, 0);
  return s.length > maxLen ? `${s.slice(0, Math.max(1, maxLen - 1))}...` : s;
}

/** Stable text key for a serialized value (dict keys, node ids, set membership). */
export function keyText(v: Val | undefined): string {
  if (typeof v === "string") return v;
  return reprInner(v, 1000, 0);
}

export const hasKey = hasOwn;
