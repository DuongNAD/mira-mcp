/**
 * The tiny expression language of Mira counters, viz bindings and prediction stops:
 * a variable name, a probe name, or len(<name>). Evaluated against recorded state only (no Python at playback).
 * Inside `expect.expr` of a stop the reserved word `return` stands for the value returned by the line.
 */
import type { Val } from "./types.js";
import { lengthOf } from "./values.js";

export type Expr = { kind: "name"; name: string } | { kind: "len"; name: string };

const NAME = /^[\p{L}_][\p{L}\p{N}\p{M}_]*$/u;
const LEN = /^len\(\s*([\p{L}_][\p{L}\p{N}\p{M}_]*)\s*\)$/u;

export function parseExpr(src: string): Expr | undefined {
  const s = src.trim();
  if (NAME.test(s)) return { kind: "name", name: s };
  const m = LEN.exec(s);
  if (m) return { kind: "len", name: m[1] as string };
  return undefined;
}

export interface EvalEnv {
  get(name: string): Val | undefined;
  /** Set when the frame returned: the value of the reserved word `return`. */
  hasReturn?: boolean;
  returnValue?: Val | undefined;
}

export function exprName(e: Expr): string {
  return e.name;
}

export function evalExpr(e: Expr, env: EvalEnv): Val | undefined {
  let base: Val | undefined;
  if (e.name === "return") {
    base = env.hasReturn ? env.returnValue : undefined;
  } else {
    base = env.get(e.name);
  }
  if (e.kind === "name") return base;
  if (base === undefined) return undefined;
  return lengthOf(base);
}

/** Convenience: parse + evaluate, undefined when the expression is invalid or has no value. */
export function evalText(src: string, env: EvalEnv): Val | undefined {
  const e = parseExpr(src);
  return e ? evalExpr(e, env) : undefined;
}
