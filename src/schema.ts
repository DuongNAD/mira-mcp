import { z } from "zod";
import type { Val } from "./player/types.js";
import { closest } from "./util.js";

export interface ValidationOutcome<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

export function formatZodErrors(issues: z.ZodIssue[], schemaShape?: Record<string, unknown>): string[] {
  return issues.slice(0, 25).map((issue) => {
    let where = "";
    issue.path.forEach((seg) => {
      if (typeof seg === "number") where += `[${seg}]`;
      else where += where ? `.${String(seg)}` : String(seg);
    });
    let msg = issue.message;
    const issueObj = issue as unknown as Record<string, unknown>;
    if (issue.code === "unrecognized_keys") {
      const keys = (issueObj.keys as string[]) ?? [];
      const allowed = schemaShape ? Object.keys(schemaShape) : [];
      const hints = keys.map((k) => [k, closest(k, allowed)] as const).filter(([, s]) => Boolean(s));
      if (hints.length) msg += ` (did you mean ${hints.map(([k, s]) => `"${s}" for "${k}"`).join(", ")}?)`;
      if (allowed.length) msg += ` - allowed keys: ${allowed.join(", ")}`;
    } else if (issue.code === "invalid_value") {
      const values = (issueObj.values as string[]) ?? (issueObj.options as string[]) ?? [];
      const received = (issueObj.input as string) ?? (issueObj.received as string);
      if (received && values.length) {
        const guess = closest(String(received), values);
        if (guess) msg += ` (did you mean "${guess}"?)`;
      }
    }
    return `${where || "(root)"}: ${msg}`;
  });
}

// Python identifiers are Unicode (Vietnamese variable names are fine).
const ID = String.raw`[\p{L}_][\p{L}\p{N}\p{M}_]*`;
const IDENT = new RegExp(`^${ID}$`, "u");
const EXPR = new RegExp(String.raw`^(len\(\s*${ID}\s*\)|${ID})$`, "u");
const FOCUS_NAME = new RegExp(`^(<module>|${ID})$`, "u");

const ident = z.string().regex(IDENT, "phải là tên biến Python hợp lệ");
const expr = z
  .string()
  .max(80)
  .regex(EXPR, "chỉ cho phép tên biến, tên probe, hoặc len(<tên>)");

/* ───────── mira_record parameters ───────── */

export const recordShape = {
  file: z.string().min(1).optional().describe("Path to the .py file to trace (absolute or relative). Optional when `lab` is given"),
  lab: z.string().min(1).optional().describe("Path to an Orion lab folder: traces <lab>/<entry> from lab.json and labels events with its subject/module"),
  call: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe("Python expression evaluated after the module is imported, e.g. tong_chu_so(-4567). Exactly one of call / script"),
  script: z.boolean().optional().describe("Run the file as __main__ instead of `call`. Exactly one of call / script"),
  focus: z
    .array(z.string())
    .max(50)
    .optional()
    .describe("Function names to trace (default: every function in the file, plus module-level code when script)"),
  probes: z
    .record(z.string(), z.string().min(1).max(500))
    .optional()
    .describe("{name: python_expression} evaluated in the frame at each traced line; errors give null"),
  stdin: z.string().max(100_000).optional().describe("Text fed to input()"),
  max_steps: z.number().int().min(1).max(20_000).optional().describe("Maximum recorded line events (default 2000, hard cap 20000)"),
  timeout_sec: z.number().min(1).max(120).optional().describe("Time box in seconds (default 10, max 120)"),
  out_dir: z.string().min(1).optional().describe("Output folder (default <file dir>/mira/<slug>/)"),
  name: z.string().min(1).max(100).optional().describe("Optional label stored in the trace"),
};
// The advertised MCP schema stays loose (no Unicode regex in JSON Schema); identifiers are validated here.
export const RecordParamsSchema = z.strictObject({
  ...recordShape,
  focus: z.array(z.string().regex(FOCUS_NAME, "tên hàm Python hợp lệ hoặc <module>")).max(50).optional(),
  probes: z.record(ident, z.string().min(1).max(500)).optional(),
});
export type RecordParams = z.output<typeof RecordParamsSchema>;

export const drillShape = {
  file: z.string().min(1).optional().describe("Path to the .py file with the function to drill. Optional when `lab` is given"),
  lab: z.string().min(1).optional().describe("Path to an Orion lab folder (uses <lab>/<entry>)"),
  function: z.string().min(1).optional().describe("Function to trace (default: derived from `call`, or the only function in the file)"),
  call: z.string().min(1).max(2000).optional().describe("Call expression; derived from a docstring example `f(args) -> result` when missing"),
  stops: z.number().int().min(1).max(8).optional().describe("Number of prediction stops (default 4, max 8)"),
  out_dir: z.string().min(1).optional().describe("Output folder (default <file dir>/mira/<slug>/)"),
  title: z.string().min(1).max(120).optional().describe("Player title"),
};
export const DrillParamsSchema = z.strictObject(drillShape);
export type DrillParams = z.output<typeof DrillParamsSchema>;

/* ───────── trace format (trace.json) ───────── */

export interface TraceBase {
  i: number;
  func: string;
  line: number;
  depth: number;
  fid: number;
  out: number;
}
export interface LineEvent extends TraceBase {
  ev: "line";
  locals: Record<string, Val>;
  types: Record<string, string>;
  changed: string[];
  probes?: Record<string, Val>;
}
export interface CallEvent extends TraceBase {
  ev: "call";
  args: Record<string, Val>;
  types: Record<string, string>;
}
export interface ReturnEvent extends TraceBase {
  ev: "return";
  value: Val;
  type: string;
  unwound?: boolean;
}
export interface ExceptionEvent extends TraceBase {
  ev: "exception";
  type: string;
  message: string;
}
export type TraceEvent = LineEvent | CallEvent | ReturnEvent | ExceptionEvent;

export interface TraceError {
  type: string;
  message: string;
  line?: number;
  traceback: string;
  timeout?: boolean;
}

export interface TraceLab {
  path: string;
  title: string;
  subject?: string;
  module?: string;
}

export interface Trace {
  v: 1;
  tool: "mira";
  file: string;
  call?: string;
  script?: boolean;
  created: string;
  python: string;
  focus: string[];
  steps: TraceEvent[];
  result?: string;
  resultValue?: Val;
  stdout: string;
  stderr: string;
  error?: TraceError;
  truncated: boolean;
  lines: Record<string, number>;
  source: string[];
  probes?: string[];
  probeErrors?: string[];
  tracerError?: string;
  incomplete?: boolean;
  timedOut?: boolean;
  lab?: TraceLab;
  name?: string;
  stats?: { events: number; lineEvents: number; elapsedMs: number };
}

const EVENT_KINDS = new Set(["line", "call", "return", "exception"]);

/** Light structural validation of a parsed trace.json (the steps are produced by our own tracer). */
export function validateTrace(raw: unknown, where = "trace.json"): Trace {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where}: phải là một object JSON.`);
  const t = raw as Record<string, unknown>;
  if (t.tool !== "mira" || t.v !== 1) throw new Error(`${where}: không phải trace của Mira v1 (thiếu tool:"mira", v:1).`);
  if (typeof t.file !== "string") throw new Error(`${where}: thiếu trường file.`);
  if (!Array.isArray(t.steps)) throw new Error(`${where}: thiếu mảng steps.`);
  if (!Array.isArray(t.source)) throw new Error(`${where}: thiếu mảng source.`);
  if (typeof t.lines !== "object" || t.lines === null) throw new Error(`${where}: thiếu bảng lines.`);
  for (let i = 0; i < t.steps.length; i++) {
    const s = t.steps[i] as Record<string, unknown> | undefined;
    if (!s || typeof s !== "object" || !EVENT_KINDS.has(String(s.ev))) throw new Error(`${where}: steps[${i}] không hợp lệ.`);
    if (typeof s.line !== "number" || typeof s.fid !== "number" || typeof s.depth !== "number" || typeof s.func !== "string") {
      throw new Error(`${where}: steps[${i}] thiếu line/fid/depth/func.`);
    }
  }
  return {
    ...(t as unknown as Trace),
    focus: Array.isArray(t.focus) ? (t.focus as string[]) : [],
    stdout: typeof t.stdout === "string" ? t.stdout : "",
    stderr: typeof t.stderr === "string" ? t.stderr : "",
    truncated: Boolean(t.truncated),
  };
}

/* ───────── build spec ───────── */

const pair = z.tuple([z.number().int(), z.number().int()]);
const title = z.string().max(80).optional();

export const ArrayVizSchema = z.strictObject({
  kind: z.literal("array"),
  var: ident,
  pointers: z.array(ident).max(6).optional(),
  title,
});
export const GridVizSchema = z
  .strictObject({
    kind: z.literal("grid"),
    var: ident.optional(),
    rows: z.number().int().min(1).max(200).optional(),
    cols: z.number().int().min(1).max(200).optional(),
    walls: expr.optional(),
    visited: expr.optional(),
    frontier: expr.optional(),
    path: expr.optional(),
    current: expr.optional(),
    start: z.union([pair, ident]).optional(),
    goal: z.union([pair, ident]).optional(),
    title,
  })
  .refine((g) => g.var !== undefined || (g.rows !== undefined && g.cols !== undefined), {
    message: "grid cần `var` (danh sách 2 chiều) hoặc cả `rows` và `cols`",
  });
export const GraphVizSchema = z
  .strictObject({
    kind: z.literal("graph"),
    nodes: expr.optional(),
    adjacency: expr.optional(),
    visited: expr.optional(),
    frontier: expr.optional(),
    current: expr.optional(),
    labels: expr.optional(),
    title,
  })
  .refine((g) => g.nodes !== undefined || g.adjacency !== undefined, {
    message: "graph cần `nodes` hoặc `adjacency`",
  });
export const StatevectorVizSchema = z.strictObject({ kind: z.literal("statevector"), var: ident, title });
export const PlotVizSchema = z.strictObject({
  kind: z.literal("plot"),
  var: ident,
  title,
  y_label: z.string().max(40).optional(),
});
export const TableVizSchema = z.strictObject({ kind: z.literal("table"), var: ident, title });
export const SeqVizSchema = z.strictObject({ kind: z.enum(["stack", "queue", "heap"]), var: ident, title });

export const VizSchema = z.union([
  ArrayVizSchema,
  GridVizSchema,
  GraphVizSchema,
  StatevectorVizSchema,
  PlotVizSchema,
  TableVizSchema,
  SeqVizSchema,
]);
export type VizSpec = z.output<typeof VizSchema>;
export const VIZ_KINDS = ["array", "grid", "graph", "statevector", "plot", "table", "stack", "queue", "heap"] as const;

export const CounterSchema = z
  .strictObject({
    label: z.string().min(1).max(40),
    expr: expr.optional(),
    line_hits: z.number().int().min(1).optional().describe("Alternative to expr: count of times this line was about to run"),
  })
  .refine((c) => (c.expr === undefined) !== (c.line_hits === undefined), {
    message: "counter cần đúng một trong `expr` hoặc `line_hits`",
  });

const StopAtSchema = z.union([
  z.strictObject({ line: z.number().int().min(1), hit: z.number().int().min(1).optional() }),
  z.strictObject({ step: z.number().int().min(0) }),
]);
const StopExpectSchema = z.union([
  z.strictObject({ expr }),
  z.strictObject({ line_next: z.literal(true) }),
  z.strictObject({ choice: z.array(z.string().min(1).max(120)).min(2).max(6), answer: z.number().int().min(0) }),
]);
export const StopSchema = z.strictObject({
  at: StopAtSchema,
  ask: z.string().min(1).max(200),
  expect: StopExpectSchema,
  kind: z.enum(["value", "line", "choice"]).optional(),
  explain: z.string().max(400).optional(),
  tolerance: z.number().min(0).optional(),
});
export type StopSpec = z.output<typeof StopSchema>;

export const BuildSpecSchema = z.strictObject({
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).optional(),
  course: z.string().max(100).optional(),
  lesson: z.string().max(100).optional(),
  trace: z.string().min(1).describe("Path to trace.json written by mira_record"),
  out_dir: z.string().min(1).optional(),
  theme: z.enum(["dark", "light"]).optional(),
  viz: z.array(VizSchema).max(3).default([]),
  counters: z.array(CounterSchema).max(4).optional(),
  stops: z.array(StopSchema).max(20).optional(),
  narration: z.record(z.string().regex(/^\d+$/, "khoá là số dòng"), z.string().max(300)).optional(),
  start_step: z.number().int().min(0).optional(),
  autoplay_ms: z.number().int().min(100).max(5000).optional(),
});
export type BuildSpec = z.output<typeof BuildSpecSchema>;
export type BuildSpecInput = z.input<typeof BuildSpecSchema>;

export function validateBuildSpec(raw: unknown): ValidationOutcome<BuildSpec> {
  const parsed = BuildSpecSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data, errors: [] };
  return { ok: false, errors: formatZodErrors(parsed.error.issues, BuildSpecSchema.shape) };
}

/* ───────── aurora-progress-event.v1 (contract) ───────── */

export const PROGRESS_TYPES = ["quiz", "predict", "recall", "complete", "card"] as const;
export const PROGRESS_RATINGS = ["right", "different", "got", "missed", "again", "hard", "good", "easy"] as const;

export interface ProgressEvent {
  v: 1;
  t: string;
  course?: string | null;
  lesson?: string | null;
  deck: string;
  slide: number;
  slideId?: string | null;
  type: (typeof PROGRESS_TYPES)[number];
  title?: string;
  prediction?: string;
  rating?: (typeof PROGRESS_RATINGS)[number];
  output?: string;
  slides?: number;
  quiz?: string | null;
  predictions?: string | null;
  [extra: string]: unknown;
}

/** Validates an object against the aurora-progress-event.v1 contract; returns a list of problems (empty = valid). */
export function validateProgressEvent(o: unknown): string[] {
  const errs: string[] = [];
  if (typeof o !== "object" || o === null || Array.isArray(o)) return ["event phải là object"];
  const e = o as Record<string, unknown>;
  if (e.v !== 1) errs.push("v: phải bằng 1");
  if (typeof e.t !== "string" || !e.t || Number.isNaN(Date.parse(e.t))) errs.push("t: cần chuỗi ISO 8601");
  if (typeof e.deck !== "string" || !e.deck) errs.push("deck: cần chuỗi không rỗng");
  if (typeof e.slide !== "number" || !Number.isInteger(e.slide) || e.slide < 0) errs.push("slide: cần số nguyên >= 0");
  if (typeof e.type !== "string" || !(PROGRESS_TYPES as readonly string[]).includes(e.type)) errs.push(`type: một trong ${PROGRESS_TYPES.join("|")}`);
  for (const k of ["course", "lesson", "slideId"]) {
    if (e[k] !== undefined && e[k] !== null && typeof e[k] !== "string") errs.push(`${k}: chuỗi hoặc null`);
  }
  const maxLen: Array<[string, number]> = [
    ["question", 200],
    ["explanation", 300],
    ["prediction", 2000],
    ["output", 300],
  ];
  for (const [k, n] of maxLen) {
    if (e[k] !== undefined && (typeof e[k] !== "string" || (e[k] as string).length > n)) errs.push(`${k}: chuỗi tối đa ${n} ký tự`);
  }
  for (const k of ["title", "palace", "place", "item", "card"]) {
    if (e[k] !== undefined && typeof e[k] !== "string") errs.push(`${k}: phải là chuỗi`);
  }
  if (e.rating !== undefined && !(PROGRESS_RATINGS as readonly string[]).includes(String(e.rating))) {
    errs.push(`rating: một trong ${PROGRESS_RATINGS.join("|")}`);
  }
  for (const k of ["chosen", "answer"]) {
    if (e[k] !== undefined && !(Array.isArray(e[k]) && (e[k] as unknown[]).every((x) => Number.isInteger(x)))) errs.push(`${k}: mảng số nguyên`);
  }
  for (const k of ["chosenText", "answerText"]) {
    if (e[k] !== undefined && !(Array.isArray(e[k]) && (e[k] as unknown[]).every((x) => typeof x === "string" && x.length <= 160))) {
      errs.push(`${k}: mảng chuỗi tối đa 160 ký tự`);
    }
  }
  if (e.correct !== undefined && typeof e.correct !== "boolean") errs.push("correct: boolean");
  for (const k of ["station", "slides", "ms"]) {
    if (e[k] !== undefined && !(typeof e[k] === "number" && Number.isInteger(e[k]) && (e[k] as number) >= 0)) errs.push(`${k}: số nguyên >= 0`);
  }
  for (const k of ["quiz", "predictions"]) {
    if (e[k] !== undefined && e[k] !== null && typeof e[k] !== "string") errs.push(`${k}: chuỗi hoặc null`);
  }
  if (e.type === "card") {
    if (typeof e.card !== "string" || !e.card) errs.push("card: bắt buộc với type card");
    if (!["again", "hard", "good", "easy"].includes(String(e.rating))) errs.push("rating: again|hard|good|easy với type card");
  }
  return errs;
}

/* ───────── exports for Polaris and Vega (shapes of Orion's export) ───────── */

export const PolarisErrorLogExportSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  module: z.string().optional(),
  lesson: z.string().optional(),
  prediction: z.string().optional(),
  result: z.string().optional(),
  why: z.string().min(1),
  fix: z.string().min(1),
  source: z.string().optional(),
});
export type ErrorLogEntry = z.output<typeof PolarisErrorLogExportSchema>;

export const VegaCardOriginSchema = z.strictObject({
  kind: z.enum(["manual", "polaris-errorlog", "polaris-fact", "aurora-notebook", "aurora-quiz", "aurora-flashcard", "aurora-palace"]),
  path: z.string().min(1),
  locator: z.string().optional(),
});
export const VegaCardCandidateSchema = z.strictObject({
  subject: z.string().optional(),
  deck: z.string().optional(),
  kind: z.enum(["basic", "cloze", "palace", "reverse"]).default("basic"),
  front: z.string().min(1),
  back: z.string(),
  hint: z.string().optional(),
  hook: z.string().optional(),
  origin: VegaCardOriginSchema,
  tags: z.array(z.string()).default([]),
});
export type VegaCardCandidate = z.output<typeof VegaCardCandidateSchema>;

/* ───────── vega-card-inbox.v1 (contract) ───────── */

export const INBOX_PRODUCERS = ["polaris", "orion", "mira", "aurora", "sirius", "manual"] as const;
export const INBOX_ORIGIN_KINDS = [
  "polaris-fact",
  "polaris-errorlog",
  "polaris-selfcheck",
  "aurora-quiz",
  "aurora-predict",
  "orion-attempt",
  "mira-stop",
  "manual",
] as const;

export interface InboxLine {
  v: 1;
  t: string;
  producer: (typeof INBOX_PRODUCERS)[number];
  key: string;
  subject: string;
  deck?: string;
  kind?: "basic" | "cloze" | "reverse";
  front: string;
  back: string;
  hint?: string;
  hook?: string;
  origin: { kind: (typeof INBOX_ORIGIN_KINDS)[number]; path: string; locator?: string; href?: string };
  tags?: string[];
  reason?: string;
}

const INBOX_KEYS = new Set(["v", "t", "producer", "key", "subject", "deck", "kind", "front", "back", "hint", "hook", "origin", "tags", "reason"]);
const ORIGIN_KEYS = new Set(["kind", "path", "locator", "href"]);
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Emoji and pictographs are not allowed anywhere in learner-facing text.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

/** Validates one line of the vega-card-inbox.v1 contract (unknown fields are rejected). Empty array = valid. */
export function validateInboxLine(o: unknown): string[] {
  const errs: string[] = [];
  if (typeof o !== "object" || o === null || Array.isArray(o)) return ["dòng phải là object"];
  const e = o as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!INBOX_KEYS.has(k)) errs.push(`trường lạ: ${k}`);
  if (e.v !== 1) errs.push("v: phải bằng 1");
  if (typeof e.t !== "string" || !ISO_DT.test(e.t)) errs.push("t: cần ISO 8601 có offset hoặc Z");
  if (!(INBOX_PRODUCERS as readonly string[]).includes(String(e.producer))) errs.push(`producer: một trong ${INBOX_PRODUCERS.join("|")}`);
  if (typeof e.key !== "string" || e.key.length < 1 || e.key.length > 200) errs.push("key: 1-200 ký tự");
  else if (typeof e.producer === "string" && !e.key.startsWith(`${e.producer}:`)) errs.push(`key: phải bắt đầu bằng "${e.producer}:"`);
  const str = (k: string, min: number, max: number, required: boolean) => {
    const v = e[k];
    if (v === undefined) {
      if (required) errs.push(`${k}: bắt buộc`);
      return;
    }
    if (typeof v !== "string" || [...v].length < min || [...v].length > max) errs.push(`${k}: chuỗi ${min}-${max} ký tự`);
    else if (EMOJI.test(v)) errs.push(`${k}: không dùng emoji`);
  };
  str("subject", 1, 120, true);
  str("deck", 0, 120, false);
  str("front", 1, 600, true);
  str("back", 0, 1200, true);
  str("hint", 0, 200, false);
  str("hook", 0, 200, false);
  str("reason", 0, 200, false);
  if (e.kind !== undefined && !["basic", "cloze", "reverse"].includes(String(e.kind))) errs.push("kind: basic|cloze|reverse");
  const origin = e.origin as Record<string, unknown> | undefined;
  if (typeof origin !== "object" || origin === null || Array.isArray(origin)) {
    errs.push("origin: bắt buộc (object)");
  } else {
    for (const k of Object.keys(origin)) if (!ORIGIN_KEYS.has(k)) errs.push(`origin: trường lạ ${k}`);
    if (!(INBOX_ORIGIN_KINDS as readonly string[]).includes(String(origin.kind))) errs.push(`origin.kind: một trong ${INBOX_ORIGIN_KINDS.join("|")}`);
    if (typeof origin.path !== "string" || origin.path.length < 1 || origin.path.length > 400) errs.push("origin.path: 1-400 ký tự");
    if (origin.locator !== undefined && (typeof origin.locator !== "string" || origin.locator.length > 120)) errs.push("origin.locator: tối đa 120 ký tự");
    if (origin.href !== undefined && (typeof origin.href !== "string" || origin.href.length > 400)) errs.push("origin.href: tối đa 400 ký tự");
  }
  if (e.tags !== undefined) {
    if (!Array.isArray(e.tags) || e.tags.length > 10 || !e.tags.every((x) => typeof x === "string" && x.length >= 1 && x.length <= 40)) {
      errs.push("tags: tối đa 10 chuỗi, mỗi chuỗi 1-40 ký tự");
    }
  }
  return errs;
}
