/**
 * Shared data shapes for the embedded player. Pure types (no runtime code) so both the Node side
 * (build.ts) and the browser player can import them.
 *
 * Serialized values (`Val`) come from the Python tracer:
 *   null | boolean | number | string | Val[]              plain JSON (int, float, bool, None, str, list)
 *   {"__float__": "3.0"}                                   integral/non-finite float ("nan", "inf", "-inf")
 *   {"__int__": "123..."}                                  integer beyond 2^53
 *   {"__str__": "...", "n": 500}                           truncated string (first part + full length)
 *   {"__list__": [...], "n": 504}                          truncated list
 *   {"__tuple__": [...], "n"?: N}                          tuple
 *   {"__set__": [...], "n"?: N, "frozen"?: true}           set / frozenset (sorted by repr)
 *   {"__dict__": [[k, v], ...], "n"?: N}                   dict with non-str keys (or truncated)
 *   {"k": v, ...}                                          dict whose keys are all (non index-like) str
 *   {"__complex__": [re, im]}                              complex
 *   {"__ndarray__": {shape, dtype, data?}}                 numpy array
 *   {"__obj__": "Name", "attrs": {...}}                    instance of a user class / namedtuple
 *   {"__repr__": "..."}                                    anything else
 */

export type Val = null | boolean | number | string | Val[] | { [key: string]: Val };

/** Container-level patch (see delta.ts). */
export type Patch =
  | { k: "d"; s?: { [key: string]: Val }; r?: string[] }
  | { k: "D"; s?: Val[][]; r?: Val[]; n?: number }
  | { k: "l"; t?: number; s?: { [index: string]: Val }; a?: Val[] }
  | { k: "s"; a?: Val[]; r?: Val[]; n?: number };

export type StepKind = "l" | "r" | "x";

/** One player step: a line event (about to run), a return event, or an exception event. */
export interface PStep {
  /** index of the event in the original trace */
  i: number;
  e: StepKind;
  /** line number (1-based) */
  n: number;
  /** index into PlayerData.funcs */
  f: number;
  /** depth among traced frames (>= 1) */
  d: number;
  /** frame instance id */
  x: number;
  /** number of stdout characters printed before this step */
  o: number;
  /** variables whose value is new or changed (full value); probes are stored under "@name" */
  c?: { [name: string]: Val };
  /** variables changed in a container-friendly way (applied on top of the previous value) */
  p?: { [name: string]: Patch };
  /** names that disappeared from the frame */
  g?: string[];
  /** type names for the entries of c and p */
  t?: { [name: string]: string };
  /** return value (e === "r") */
  v?: Val;
  /** type name of the return value */
  vt?: string;
  /** the return was caused by an exception unwinding the frame */
  w?: 1;
  /** exception [type, message] (e === "x") */
  ex?: [string, string];
}

export type VizKind = "array" | "grid" | "graph" | "statevector" | "plot" | "table" | "stack" | "queue" | "heap";

export interface ArrayCfg {
  kind: "array";
  var: string;
  pointers?: string[];
  title?: string;
}
export interface GridCfg {
  kind: "grid";
  var?: string;
  rows?: number;
  cols?: number;
  walls?: string;
  visited?: string;
  frontier?: string;
  path?: string;
  current?: string;
  start?: [number, number] | string;
  goal?: [number, number] | string;
  title?: string;
}
export interface GraphCfg {
  kind: "graph";
  nodes?: string;
  adjacency?: string;
  visited?: string;
  frontier?: string;
  current?: string;
  labels?: string;
  title?: string;
}
export interface StatevectorCfg {
  kind: "statevector";
  var: string;
  title?: string;
}
export interface PlotCfg {
  kind: "plot";
  var: string;
  title?: string;
  y_label?: string;
}
export interface TableCfg {
  kind: "table";
  var: string;
  title?: string;
}
export interface SeqCfg {
  kind: "stack" | "queue" | "heap";
  var: string;
  title?: string;
}
export type VizCfg = ArrayCfg | GridCfg | GraphCfg | StatevectorCfg | PlotCfg | TableCfg | SeqCfg;

export interface CounterCfg {
  label: string;
  /** a variable / probe name or len(name) */
  expr?: string;
  /** alternative: number of times this line has been about to run up to the current step */
  lineHits?: number;
}

export type StopKind = "value" | "line" | "choice";

export interface StopCfg {
  /** 1-based stop number (slideId is `mira-stop-<k>`) */
  k: number;
  /** step position where the gate opens (the line is about to run) */
  pos: number;
  /** step position holding the outcome (next event of the same frame), or -1 */
  post: number;
  line: number;
  ask: string;
  kind: StopKind;
  expr?: string;
  choice?: string[];
  answer?: number;
  explain?: string;
  tolerance?: number;
}

export interface PlayerMeta {
  title: string;
  subtitle?: string;
  course?: string;
  lesson?: string;
  slug: string;
  /** base name of the traced file */
  file: string;
  call?: string;
  script?: boolean;
  python: string;
  created: string;
  theme: "dark" | "light";
  autoplayMs: number;
  startStep: number;
  truncated: boolean;
  version: string;
}

export interface PlayerError {
  type: string;
  message: string;
  line?: number;
}

export interface PlayerData {
  v: 1;
  meta: PlayerMeta;
  funcs: string[];
  steps: PStep[];
  source: string[];
  /** highlighted HTML per source line */
  hl: string[];
  narration: { [line: string]: string };
  stdout: string;
  result?: string;
  error?: PlayerError;
  viz: VizCfg[];
  counters: CounterCfg[];
  stops: StopCfg[];
}
