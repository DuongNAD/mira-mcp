/**
 * Player model: rebuilds the state at any step from the compact step list (deltas and patches), lazily and with
 * structural sharing, so stepping through thousands of steps stays cheap. Pure (no DOM); also used by the e2e tests
 * to prove that the embedded data reproduces the recorded trace exactly.
 */
import { applyPatch } from "./delta.js";
import { type EvalEnv, evalExpr, parseExpr } from "./expr.js";
import type { PlayerData, PStep, StopCfg, Val } from "./types.js";

export interface FrameState {
  vars: { [name: string]: Val };
  types: { [name: string]: string };
  /** names that are new or changed at this step */
  changed: string[];
}

const EMPTY: FrameState = { vars: {}, types: {}, changed: [] };

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export class Model {
  readonly data: PlayerData;
  readonly steps: PStep[];
  readonly n: number;
  /** previous step of the same frame, or -1 */
  readonly prevSame: Int32Array;
  /** next step of the same frame, or -1 */
  readonly nextSame: Int32Array;
  /** step of the caller frame (its latest step when this frame was entered), or -1 */
  readonly callerOf: Int32Array;
  private cache: Array<FrameState | undefined>;
  private lineSteps = new Map<number, number[]>();

  constructor(data: PlayerData) {
    this.data = data;
    this.steps = data.steps;
    this.n = data.steps.length;
    this.prevSame = new Int32Array(this.n).fill(-1);
    this.nextSame = new Int32Array(this.n).fill(-1);
    this.callerOf = new Int32Array(this.n).fill(-1);
    this.cache = new Array<FrameState | undefined>(this.n).fill(undefined);

    const lastOfFrame = new Map<number, number>();
    const frameCaller = new Map<number, number>();
    const stackFid: number[] = [];
    for (let k = 0; k < this.n; k++) {
      const s = this.steps[k] as PStep;
      if (!lastOfFrame.has(s.x)) {
        const parent = s.d >= 2 ? stackFid[s.d - 2] : undefined;
        frameCaller.set(s.x, parent !== undefined ? (lastOfFrame.get(parent) ?? -1) : -1);
      }
      const prev = lastOfFrame.get(s.x);
      if (prev !== undefined) {
        this.prevSame[k] = prev;
        this.nextSame[prev] = k;
      }
      lastOfFrame.set(s.x, k);
      stackFid.length = Math.max(0, s.d - 1);
      stackFid[s.d - 1] = s.x;
      this.callerOf[k] = frameCaller.get(s.x) ?? -1;
      if (s.e === "l") {
        let arr = this.lineSteps.get(s.n);
        if (!arr) {
          arr = [];
          this.lineSteps.set(s.n, arr);
        }
        arr.push(k);
      }
    }
  }

  funcName(k: number): string {
    const s = this.steps[k];
    return s ? (this.data.funcs[s.f] ?? "?") : "?";
  }

  /** Variables of the frame that owns step k (state before a line runs / at a return). */
  frameState(k: number): FrameState {
    if (k < 0 || k >= this.n) return EMPTY;
    const hit = this.cache[k];
    if (hit) return hit;
    const chain: number[] = [];
    let j = k;
    while (j >= 0 && !this.cache[j]) {
      chain.push(j);
      j = this.prevSame[j] as number;
    }
    let base: FrameState = j >= 0 ? (this.cache[j] as FrameState) : EMPTY;
    for (let idx = chain.length - 1; idx >= 0; idx--) {
      const s = chain[idx] as number;
      base = this.applyStep(base, this.steps[s] as PStep);
      this.cache[s] = base;
    }
    return this.cache[k] as FrameState;
  }

  private applyStep(base: FrameState, step: PStep): FrameState {
    if (!step.c && !step.p && !step.g) return { vars: base.vars, types: base.types, changed: [] };
    const vars: { [name: string]: Val } = { ...base.vars };
    const types: { [name: string]: string } = { ...base.types };
    const changed: string[] = [];
    if (step.g) {
      for (const name of step.g) {
        delete vars[name];
        delete types[name];
      }
    }
    if (step.c) {
      for (const name of Object.keys(step.c)) {
        vars[name] = step.c[name] as Val;
        changed.push(name);
      }
    }
    if (step.p) {
      for (const name of Object.keys(step.p)) {
        vars[name] = applyPatch(hasOwn(base.vars, name) ? base.vars[name] : undefined, step.p[name] as never);
        changed.push(name);
      }
    }
    if (step.t) for (const name of Object.keys(step.t)) types[name] = step.t[name] as string;
    return { vars, types, changed };
  }

  /** Looks a name up in the frame of step k, then in its callers; probes are stored as "@name". */
  get(k: number, name: string): Val | undefined {
    let j = k;
    const probe = `@${name}`;
    let guard = 0;
    while (j >= 0 && guard++ < 10000) {
      const st = this.frameState(j);
      if (hasOwn(st.vars, name)) return st.vars[name];
      if (hasOwn(st.vars, probe)) return st.vars[probe];
      j = this.callerOf[j] as number;
    }
    return undefined;
  }

  /** Evaluation environment at step k (the reserved word `return` is the value returned at a return step). */
  env(k: number): EvalEnv {
    const s = this.steps[k];
    const returned = s?.e === "r";
    return {
      get: (name: string) => this.get(k, name),
      hasReturn: returned,
      returnValue: returned ? s?.v : undefined,
    };
  }

  evalAt(k: number, expr: string): Val | undefined {
    const e = parseExpr(expr);
    return e ? evalExpr(e, this.env(k)) : undefined;
  }

  /** Function names of the call stack at step k, outermost first. */
  stackAt(k: number): string[] {
    const out: string[] = [];
    let j = k;
    let guard = 0;
    while (j >= 0 && guard++ < 10000) {
      out.push(this.funcName(j));
      j = this.callerOf[j] as number;
    }
    return out.reverse();
  }

  /** Line that just executed (the line of the previous step), or 0. */
  executedLine(k: number): number {
    return k > 0 ? (this.steps[k - 1]?.n ?? 0) : 0;
  }

  /** Line that is about to run, or 0 when the step is a return / exception. */
  nextLine(k: number): number {
    const s = this.steps[k];
    return s && s.e === "l" ? s.n : 0;
  }

  /** How many times `line` has been about to run, up to and including step k. */
  hitsUpTo(line: number, k: number): number {
    const arr = this.lineSteps.get(line);
    if (!arr) return 0;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((arr[mid] as number) <= k) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Value a stop asks for: the expression evaluated after its line ran, or the line that runs next. */
  stopOutcome(stop: StopCfg): { ok: boolean; value?: Val; line?: number } {
    if (stop.post < 0) return { ok: false };
    const post = this.steps[stop.post];
    if (!post) return { ok: false };
    if (stop.kind === "line") return post.e === "l" ? { ok: true, line: post.n } : { ok: false };
    if (stop.kind === "choice") return { ok: true };
    const v = this.evalAt(stop.post, stop.expr ?? "");
    return v === undefined ? { ok: false } : { ok: true, value: v };
  }

  /** Index of the first stop whose gate position is after `pos`, or -1. */
  nextStopAfter(pos: number): number {
    for (let i = 0; i < this.data.stops.length; i++) {
      if ((this.data.stops[i] as StopCfg).pos > pos) return i;
    }
    return -1;
  }

  stopAt(pos: number): StopCfg | undefined {
    return this.data.stops.find((s) => s.pos === pos);
  }
}
