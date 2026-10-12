/**
 * Container-level delta encoding for serialized values.
 *
 * The trace stores the full state at every event, which is too large to embed (a visited-set that grows by one
 * cell per step would be re-serialized hundreds of times). The builder replaces each changed container by a
 * small patch relative to the previous value of the same variable, and the player applies the patches.
 * Pure functions, used by Node (diff) and the browser (apply).
 */
import type { Patch, Val } from "./types.js";

export const TAGS = [
  "__tuple__",
  "__set__",
  "__complex__",
  "__ndarray__",
  "__obj__",
  "__repr__",
  "__float__",
  "__int__",
  "__str__",
  "__list__",
  "__dict__",
] as const;

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isPlainObject(v: unknown): v is { [key: string]: Val } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns the tag key of a tagged object (e.g. "__set__"), or undefined for a plain dict / non-object. */
export function tagOf(v: unknown): (typeof TAGS)[number] | undefined {
  if (!isPlainObject(v)) return undefined;
  for (const t of TAGS) if (hasOwn(v, t)) return t;
  return undefined;
}

/** Defines an own enumerable property without triggering the `__proto__` setter. */
export function setOwn(o: { [key: string]: Val }, k: string, v: Val): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

export function deepEqual(a: Val | undefined, b: Val | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!hasOwn(b, k)) return false;
    if (!deepEqual((a as { [key: string]: Val })[k], (b as { [key: string]: Val })[k])) return false;
  }
  return true;
}

const keyOf = (v: Val): string => JSON.stringify(v);

export function sizeOf(v: unknown): number {
  return JSON.stringify(v)?.length ?? 0;
}


/* ───────── ordering of set elements (mirrors the tracer's natural sort for common element types) ───────── */

function numberLike(v: Val): number | undefined {
  if (typeof v === "number") return v;
  if (isPlainObject(v)) {
    if (typeof v.__float__ === "string") {
      const f = v.__float__;
      return f === "nan" ? Number.NaN : f === "inf" ? Infinity : f === "-inf" ? -Infinity : Number.parseFloat(f);
    }
    if (typeof v.__int__ === "string") return Number(v.__int__);
  }
  return undefined;
}

function seqLike(v: Val): Val[] | undefined {
  if (Array.isArray(v)) return v;
  if (isPlainObject(v) && Array.isArray(v.__tuple__)) return v.__tuple__ as Val[];
  return undefined;
}

/** Natural ordering of serialized values: numbers, strings, tuples/lists lexicographically, else by JSON text. */
export function cmpVal(a: Val, b: Val): number {
  const na = numberLike(a);
  const nb = numberLike(b);
  if (na !== undefined && nb !== undefined) return na < nb ? -1 : na > nb ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  const sa = seqLike(a);
  const sb = seqLike(b);
  if (sa && sb) {
    const n = Math.min(sa.length, sb.length);
    for (let i = 0; i < n; i++) {
      const c = cmpVal(sa[i] as Val, sb[i] as Val);
      if (c !== 0) return c;
    }
    return sa.length - sb.length;
  }
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  return ja < jb ? -1 : ja > jb ? 1 : 0;
}

function insertSorted(items: Val[], x: Val): void {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmpVal(items[mid] as Val, x) <= 0) lo = mid + 1;
    else hi = mid;
  }
  items.splice(lo, 0, x);
}

/* ───────── apply ───────── */

export function applyPatch(old: Val | undefined, patch: Patch): Val {
  switch (patch.k) {
    case "d": {
      const out: { [key: string]: Val } = {};
      if (isPlainObject(old)) for (const k of Object.keys(old)) setOwn(out, k, old[k] as Val);
      for (const k of patch.r ?? []) delete out[k];
      if (patch.s) for (const k of Object.keys(patch.s)) setOwn(out, k, patch.s[k] as Val);
      return out;
    }
    case "D": {
      const base = isPlainObject(old) && Array.isArray(old.__dict__) ? (old.__dict__ as Val[][]) : [];
      const removed = new Set((patch.r ?? []).map(keyOf));
      const replace = new Map<string, Val[]>();
      for (const pair of patch.s ?? []) replace.set(keyOf(pair[0] as Val), pair);
      const pairs: Val[][] = [];
      const seen = new Set<string>();
      for (const pair of base) {
        const key = keyOf(pair[0] as Val);
        if (removed.has(key)) continue;
        seen.add(key);
        pairs.push(replace.get(key) ?? pair);
      }
      for (const [key, pair] of replace) if (!seen.has(key)) pairs.push(pair);
      const out: { [key: string]: Val } = { __dict__: pairs as Val };
      const n = patch.n ?? (isPlainObject(old) && typeof old.n === "number" ? old.n : undefined);
      if (n !== undefined) out.n = n;
      return out;
    }
    case "l": {
      const arr = Array.isArray(old) ? old.slice() : [];
      if (patch.t !== undefined) arr.length = patch.t;
      if (patch.s) for (const k of Object.keys(patch.s)) arr[Number(k)] = patch.s[k] as Val;
      if (patch.a) for (const x of patch.a) arr.push(x);
      return arr;
    }
    case "s": {
      const baseObj = isPlainObject(old) ? old : {};
      const base = Array.isArray(baseObj.__set__) ? (baseObj.__set__ as Val[]) : [];
      const removed = new Set((patch.r ?? []).map(keyOf));
      const items = base.filter((x) => !removed.has(keyOf(x)));
      for (const x of patch.a ?? []) insertSorted(items, x);
      const out: { [key: string]: Val } = {};
      for (const k of Object.keys(baseObj)) setOwn(out, k, baseObj[k] as Val);
      out.__set__ = items;
      if (patch.n !== undefined) out.n = patch.n;
      return out;
    }
  }
}

/* ───────── diff (Node side) ───────── */

function limit(n: number): number {
  return Math.max(8, Math.floor(n / 4));
}

/**
 * Computes a patch turning `a` into `b`, or undefined when no patch applies or the change is too large
 * (the caller then stores `b` in full). The result always satisfies deepEqual(applyPatch(a, p), b)
 * (up to set/dict ordering) - verified by the e2e tests.
 */
export function diffValue(a: Val | undefined, b: Val): Patch | undefined {
  if (a === undefined) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) return diffList(a, b);
  if (!isPlainObject(a) || !isPlainObject(b)) return undefined;
  const ta = tagOf(a);
  const tb = tagOf(b);
  if (ta === undefined && tb === undefined) return diffDict(a, b);
  if (ta === "__dict__" && tb === "__dict__") return diffPairDict(a, b);
  if (ta === "__set__" && tb === "__set__") return diffSet(a, b);
  return undefined;
}

function diffList(a: Val[], b: Val[]): Patch | undefined {
  const m = Math.min(a.length, b.length);
  const s: { [index: string]: Val } = {};
  let changed = 0;
  for (let i = 0; i < m; i++) {
    if (!deepEqual(a[i], b[i])) {
      s[String(i)] = b[i] as Val;
      changed++;
      if (changed > limit(m)) return undefined;
    }
  }
  const patch: Patch = { k: "l" };
  if (b.length < a.length) patch.t = b.length;
  if (changed > 0) patch.s = s;
  if (b.length > a.length) patch.a = b.slice(a.length);
  return patch;
}

function diffDict(a: { [key: string]: Val }, b: { [key: string]: Val }): Patch | undefined {
  const s: { [key: string]: Val } = {};
  const r: string[] = [];
  let count = 0;
  const cap = limit(Object.keys(b).length);
  for (const k of Object.keys(b)) {
    if (!hasOwn(a, k) || !deepEqual(a[k], b[k])) {
      setOwn(s, k, b[k] as Val);
      if (++count > cap) return undefined;
    }
  }
  for (const k of Object.keys(a)) {
    if (!hasOwn(b, k)) {
      r.push(k);
      if (++count > cap) return undefined;
    }
  }
  const patch: Patch = { k: "d" };
  if (r.length) patch.r = r;
  if (Object.keys(s).length) patch.s = s;
  return patch;
}

function diffPairDict(a: { [key: string]: Val }, b: { [key: string]: Val }): Patch | undefined {
  if (!Array.isArray(a.__dict__) || !Array.isArray(b.__dict__)) return undefined;
  const pa = a.__dict__ as Val[][];
  const pb = b.__dict__ as Val[][];
  const ma = new Map<string, Val>();
  for (const p of pa) ma.set(keyOf(p[0] as Val), p[1] as Val);
  const mb = new Set<string>();
  const s: Val[][] = [];
  const r: Val[] = [];
  const cap = limit(pb.length);
  for (const p of pb) {
    const key = keyOf(p[0] as Val);
    mb.add(key);
    if (!ma.has(key) || !deepEqual(ma.get(key), p[1] as Val)) {
      s.push(p);
      if (s.length + r.length > cap) return undefined;
    }
  }
  for (const p of pa) {
    if (!mb.has(keyOf(p[0] as Val))) {
      r.push(p[0] as Val);
      if (s.length + r.length > cap) return undefined;
    }
  }
  const patch: Patch = { k: "D" };
  if (s.length) patch.s = s;
  if (r.length) patch.r = r;
  const na = typeof a.n === "number" ? a.n : undefined;
  const nb = typeof b.n === "number" ? b.n : undefined;
  if (na !== nb && nb !== undefined) patch.n = nb;
  if (na !== nb && nb === undefined) return undefined;
  return patch;
}

function diffSet(a: { [key: string]: Val }, b: { [key: string]: Val }): Patch | undefined {
  if (!Array.isArray(a.__set__) || !Array.isArray(b.__set__)) return undefined;
  if (a.frozen !== b.frozen) return undefined;
  for (const k of Object.keys(b)) if (k !== "__set__" && k !== "n" && k !== "frozen") return undefined;
  const ia = a.__set__ as Val[];
  const ib = b.__set__ as Val[];
  const ka = new Set(ia.map(keyOf));
  const kb = new Set(ib.map(keyOf));
  const add: Val[] = [];
  const rem: Val[] = [];
  const cap = limit(ib.length);
  for (const x of ib) {
    if (!ka.has(keyOf(x))) {
      add.push(x);
      if (add.length + rem.length > cap) return undefined;
    }
  }
  for (const x of ia) {
    if (!kb.has(keyOf(x))) {
      rem.push(x);
      if (add.length + rem.length > cap) return undefined;
    }
  }
  if (ib.length !== ia.length - rem.length + add.length) return undefined; // duplicates: not a real set
  const patch: Patch = { k: "s" };
  if (add.length) patch.a = add;
  if (rem.length) patch.r = rem;
  const na = typeof a.n === "number" ? a.n : undefined;
  const nb = typeof b.n === "number" ? b.n : undefined;
  if (na !== nb) {
    if (nb === undefined) return undefined;
    patch.n = nb;
  }
  return patch;
}

/** Chooses between a patch and the full value: the patch must be clearly smaller. */
export function bestEncoding(prev: Val | undefined, next: Val): { patch: Patch } | { full: Val } {
  if (prev !== undefined) {
    const patch = diffValue(prev, next);
    if (patch && sizeOf(patch) < sizeOf(next) * 0.6) return { patch };
  }
  return { full: next };
}
