import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import playerCss from "virtual:player-css";
import playerJs from "virtual:player-js";
import { highlightLines } from "./highlight.js";
import { labLabels } from "./lab.js";
import { bestEncoding, deepEqual } from "./player/delta.js";
import { parseExpr } from "./player/expr.js";
import { Model } from "./player/model.js";
import type {
  CounterCfg,
  PlayerData,
  PlayerError,
  PStep,
  StopCfg,
  Val,
  VizCfg,
} from "./player/types.js";
import { type BuildSpec, type StopSpec, type Trace, validateBuildSpec, validateTrace } from "./schema.js";
import { notifySmartDrive } from "./smartdrive.js";
import { VERSION, atomicWriteFile, closest, esc, slugify } from "./util.js";

const MAX_STEPS_EMBED = 5000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

export interface AuroraSlide {
  type: "trace";
  eyebrow: string;
  title: string;
  player: string;
  caption: string;
}

export interface StopInfo {
  k: number;
  line: number;
  kind: string;
  ask: string;
}

export interface CheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  steps?: number;
  stops?: StopInfo[];
  tracePath?: string;
  outDir?: string;
  data?: PlayerData;
  spec?: BuildSpec;
  trace?: Trace;
}

export interface BuildResult extends CheckResult {
  indexPath?: string;
  bytes?: number;
  auroraSlide?: AuroraSlide;
  text: string;
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/* ───────── compaction: full per-event locals -> deltas and patches ───────── */

export interface Compact {
  steps: PStep[];
  funcs: string[];
  total: number;
  trimmed: boolean;
}

export function compactTrace(trace: Trace, maxSteps: number): Compact {
  const funcs: string[] = [];
  const funcIndex = new Map<string, number>();
  const fi = (name: string): number => {
    let idx = funcIndex.get(name);
    if (idx === undefined) {
      idx = funcs.length;
      funcs.push(name);
      funcIndex.set(name, idx);
    }
    return idx;
  };
  const steps: PStep[] = [];
  const prevVars = new Map<number, Record<string, Val>>();
  let total = 0;
  let trimmed = false;
  for (const ev of trace.steps) {
    if (ev.ev === "call") continue;
    total++;
    if (steps.length >= maxSteps) {
      trimmed = true;
      continue;
    }
    const step: PStep = { i: ev.i, e: "l", n: ev.line, f: fi(ev.func), d: ev.depth, x: ev.fid, o: ev.out };
    if (ev.ev === "line") {
      const vars: Record<string, Val> = {};
      for (const k of Object.keys(ev.locals)) Object.defineProperty(vars, k, { value: ev.locals[k], enumerable: true, writable: true, configurable: true });
      if (ev.probes) {
        for (const k of Object.keys(ev.probes)) {
          Object.defineProperty(vars, `@${k}`, { value: ev.probes[k], enumerable: true, writable: true, configurable: true });
        }
      }
      const prev = prevVars.get(ev.fid);
      for (const name of Object.keys(vars)) {
        const nv = vars[name] as Val;
        const pv = prev && hasOwn(prev, name) ? prev[name] : undefined;
        if (pv !== undefined && deepEqual(pv, nv)) continue;
        const enc = bestEncoding(pv, nv);
        if ("patch" in enc) (step.p ??= {})[name] = enc.patch;
        else (step.c ??= {})[name] = enc.full;
        const tn = name.startsWith("@") ? undefined : ev.types[name];
        if (tn) (step.t ??= {})[name] = tn;
      }
      if (prev) {
        for (const name of Object.keys(prev)) if (!hasOwn(vars, name)) (step.g ??= []).push(name);
      }
      prevVars.set(ev.fid, vars);
    } else if (ev.ev === "return") {
      step.e = "r";
      step.v = ev.value;
      step.vt = ev.type;
      if (ev.unwound) step.w = 1;
      prevVars.delete(ev.fid);
    } else {
      step.e = "x";
      step.ex = [ev.type, ev.message];
    }
    steps.push(step);
  }
  return { steps, funcs, total, trimmed };
}

/* ───────── helpers ───────── */

function knownNames(trace: Trace): { names: Set<string>; types: Map<string, Set<string>> } {
  const names = new Set<string>();
  const types = new Map<string, Set<string>>();
  for (const ev of trace.steps) {
    if (ev.ev !== "line") continue;
    for (const [name, t] of Object.entries(ev.types)) {
      names.add(name);
      let set = types.get(name);
      if (!set) {
        set = new Set();
        types.set(name, set);
      }
      set.add(t);
    }
    for (const name of Object.keys(ev.locals)) names.add(name);
  }
  for (const p of trace.probes ?? []) names.add(p);
  return { names, types };
}

function nearestLine(trace: Trace, line: number): number | undefined {
  let best: number | undefined;
  for (const k of Object.keys(trace.lines)) {
    const n = Number(k);
    if (best === undefined || Math.abs(n - line) < Math.abs(best - line)) best = n;
  }
  return best;
}

function nameHint(name: string, known: Set<string>): string {
  const guess = closest(name, [...known]);
  const list = [...known].slice(0, 24).join(", ");
  return `${guess ? ` Có phải "${guess}"?` : ""} Biến có trong vết: ${list || "(không có)"}.`;
}

const LISTISH = new Set(["list", "tuple", "deque", "ndarray", "set", "frozenset"]);
const VIZ_TYPES: Record<string, { want: Set<string>; label: string }> = {
  array: { want: new Set(["list", "tuple", "deque", "ndarray"]), label: "danh sách" },
  stack: { want: new Set(["list", "tuple", "deque"]), label: "danh sách" },
  queue: { want: new Set(["list", "tuple", "deque"]), label: "danh sách hoặc deque" },
  heap: { want: new Set(["list", "tuple"]), label: "danh sách (heap)" },
  plot: { want: new Set(["list", "tuple", "deque", "ndarray"]), label: "danh sách số" },
  statevector: { want: new Set(["list", "tuple", "ndarray"]), label: "danh sách số phức hoặc mảng numpy" },
  table: { want: new Set(["dict", "list", "tuple", "OrderedDict", "defaultdict", "Counter", "ndarray"]), label: "dict hoặc danh sách" },
};

function exprNameOf(src: string): string | undefined {
  const e = parseExpr(src);
  return e?.name;
}

/* ───────── validation + data assembly ───────── */

export interface PlanOptions {
  /** Folder that relative `trace` paths resolve against (default: the current directory). */
  baseDir?: string;
}

export async function planBuild(rawSpec: unknown, opts: PlanOptions = {}): Promise<CheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const v = validateBuildSpec(rawSpec);
  if (!v.ok || !v.value) return { ok: false, errors: v.errors, warnings };
  const spec = v.value;

  const tracePath = isAbsolute(spec.trace) ? spec.trace : resolve(opts.baseDir ?? process.cwd(), spec.trace);
  if (!existsSync(tracePath)) {
    return { ok: false, errors: [`Không tìm thấy trace: ${tracePath}. Chạy mira_record trước và dùng đường dẫn trace.json nó trả về.`], warnings };
  }
  let trace: Trace;
  try {
    trace = validateTrace(JSON.parse((await readFile(tracePath, "utf8")).replace(/^\uFEFF/, "")), tracePath);
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings };
  }

  const compact = compactTrace(trace, MAX_STEPS_EMBED);
  if (compact.steps.length === 0) {
    return {
      ok: false,
      errors: [
        trace.error
          ? `Vết không có dòng nào để phát lại (chương trình lỗi ngay: ${trace.error.type}: ${trace.error.message}).`
          : "Vết không có dòng nào để phát lại: kiểm tra `focus` hoặc biểu thức `call` khi ghi.",
      ],
      warnings,
    };
  }
  if (compact.trimmed) {
    warnings.push(`Vết có ${compact.total} bước; chỉ nhúng ${MAX_STEPS_EMBED} bước đầu để player nhẹ (giới hạn 3 MB).`);
  }
  if (trace.truncated) warnings.push("Vết đã bị cắt khi ghi (đạt max_steps): phần cuối chương trình không có trong player.");
  if (trace.error && !trace.timedOut) warnings.push(`Chương trình kết thúc bằng lỗi ${trace.error.type}: ${trace.error.message}`);
  if (trace.timedOut) warnings.push("Vết này ghi từ một lần chạy bị hết thời gian (lặp vô hạn?).");

  const { names, types } = knownNames(trace);
  const sourceLines = trace.source.length;

  /* viz */
  const viz: VizCfg[] = [];
  const checkName = (where: string, src: string | undefined): void => {
    if (src === undefined) return;
    const n = exprNameOf(src);
    if (!n) {
      errors.push(`${where}: biểu thức "${src}" không hợp lệ (chỉ cho phép tên biến, tên probe hoặc len(<tên>)).`);
      return;
    }
    if (!names.has(n)) errors.push(`${where}: không tìm thấy biến "${n}" trong vết.${nameHint(n, names)}`);
  };
  spec.viz.forEach((z, idx) => {
    const where = `viz[${idx}] (${z.kind})`;
    const cfg: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(z)) if (val !== undefined) cfg[k] = val;
    if ("var" in z && z.var !== undefined) {
      checkName(`${where}.var`, z.var);
      const t = VIZ_TYPES[z.kind];
      const seen = types.get(z.var);
      if (t && seen && ![...seen].some((x) => t.want.has(x))) {
        warnings.push(`${where}.var: "${z.var}" có kiểu ${[...seen].join("/")}, ${z.kind} cần ${t.label}.`);
      }
    }
    if (z.kind === "array") for (const p of z.pointers ?? []) checkName(`${where}.pointers`, p);
    if (z.kind === "grid") {
      for (const key of ["walls", "visited", "frontier", "path", "current"] as const) checkName(`${where}.${key}`, z[key]);
      for (const key of ["start", "goal"] as const) {
        const s = z[key];
        if (typeof s === "string") checkName(`${where}.${key}`, s);
      }
      if (z.var) {
        const seen = types.get(z.var);
        if (seen && ![...seen].some((x) => LISTISH.has(x))) warnings.push(`${where}.var: "${z.var}" cần là danh sách 2 chiều.`);
      }
    }
    if (z.kind === "graph") {
      for (const key of ["nodes", "adjacency", "visited", "frontier", "current", "labels"] as const) checkName(`${where}.${key}`, z[key]);
    }
    viz.push(cfg as unknown as VizCfg);
  });

  /* counters */
  const counters: CounterCfg[] = [];
  (spec.counters ?? []).forEach((c, idx) => {
    const where = `counters[${idx}] (${c.label})`;
    if (c.expr !== undefined) {
      checkName(where, c.expr);
      counters.push({ label: c.label, expr: c.expr });
    } else if (c.line_hits !== undefined) {
      if (!trace.lines[String(c.line_hits)]) warnings.push(`${where}: dòng ${c.line_hits} chưa bao giờ chạy trong vết.`);
      counters.push({ label: c.label, lineHits: c.line_hits });
    }
  });

  /* narration */
  const narration: Record<string, string> = {};
  for (const [k, text] of Object.entries(spec.narration ?? {})) {
    const line = Number(k);
    if (line < 1 || line > sourceLines) {
      errors.push(`narration["${k}"]: dòng ngoài phạm vi 1-${sourceLines}.`);
      continue;
    }
    if (!trace.lines[k]) warnings.push(`narration["${k}"]: dòng này chưa bao giờ chạy trong vết nên chú thích sẽ không hiện.`);
    narration[k] = text;
  }

  const startStep = spec.start_step ?? 0;
  if (startStep >= compact.steps.length) {
    errors.push(`start_step=${startStep} vượt quá số bước (${compact.steps.length}).`);
  }

  /* draft player data (without stops) so stops can be validated through the real model */
  const err: PlayerError | undefined = trace.error
    ? { type: trace.error.type, message: trace.error.message, ...(trace.error.line ? { line: trace.error.line } : {}) }
    : undefined;
  const labels = labLabels(trace.lab);
  const course = spec.course ?? labels.course;
  const lesson = spec.lesson ?? labels.lesson;
  const data: PlayerData = {
    v: 1,
    meta: {
      title: spec.title,
      ...(spec.subtitle ? { subtitle: spec.subtitle } : trace.call ? { subtitle: trace.call } : {}),
      ...(course ? { course } : {}),
      ...(lesson ? { lesson } : {}),
      slug: slugify(spec.title, 48),
      file: basename(trace.file),
      ...(trace.call ? { call: trace.call } : {}),
      ...(trace.script ? { script: true } : {}),
      python: trace.python,
      created: trace.created,
      theme: spec.theme ?? "dark",
      autoplayMs: spec.autoplay_ms ?? 600,
      startStep: Math.min(startStep, compact.steps.length - 1),
      truncated: trace.truncated || compact.trimmed,
      version: VERSION,
    },
    funcs: compact.funcs,
    steps: compact.steps,
    source: trace.source,
    hl: highlightLines(trace.source),
    narration,
    stdout: trace.stdout,
    ...(trace.result !== undefined ? { result: trace.result } : {}),
    ...(err ? { error: err } : {}),
    viz,
    counters,
    stops: [],
  };

  /* stops */
  const stopInfos: StopInfo[] = [];
  const model = new Model(data);
  const linePositions = new Map<number, number[]>();
  const posOfEvent = new Map<number, number>();
  compact.steps.forEach((s, pos) => {
    posOfEvent.set(s.i, pos);
    if (s.e === "l") {
      const arr = linePositions.get(s.n) ?? [];
      arr.push(pos);
      linePositions.set(s.n, arr);
    }
  });
  const resolved: Array<{ pos: number; post: number; spec: StopSpec; index: number }> = [];
  (spec.stops ?? []).forEach((stop, index) => {
    const where = `stops[${index}]`;
    let pos = -1;
    if ("line" in stop.at) {
      const line = stop.at.line;
      const hit = stop.at.hit ?? 1;
      const total = trace.lines[String(line)] ?? 0;
      if (total === 0) {
        const near = nearestLine(trace, line);
        errors.push(
          `${where}: dòng ${line} chưa bao giờ chạy trong vết.${near !== undefined ? ` Dòng gần nhất đã chạy: ${near}.` : ""} Các dòng đã chạy: ${Object.keys(trace.lines).slice(0, 30).join(", ")}.`,
        );
        return;
      }
      if (total < hit) {
        errors.push(`${where}: dòng ${line} chỉ chạy ${total} lần, không có lần thứ ${hit}.`);
        return;
      }
      const arr = linePositions.get(line) ?? [];
      const p = arr[hit - 1];
      if (p === undefined) {
        errors.push(`${where}: lần thứ ${hit} của dòng ${line} nằm ngoài phần vết đã nhúng (${compact.steps.length} bước).`);
        return;
      }
      pos = p;
    } else {
      const p = posOfEvent.get(stop.at.step);
      if (p === undefined) {
        errors.push(`${where}: step ${stop.at.step} không tồn tại trong phần vết đã nhúng (0-${(compact.steps[compact.steps.length - 1] as PStep).i}).`);
        return;
      }
      if ((compact.steps[p] as PStep).e !== "l") {
        errors.push(`${where}: step ${stop.at.step} không phải một dòng sắp chạy (là return hoặc exception).`);
        return;
      }
      pos = p;
    }
    const post = model.nextSame[pos] as number;
    if (post < 0) {
      errors.push(`${where}: không có kết quả sau dòng ${(compact.steps[pos] as PStep).n} (vết bị cắt hoặc dòng này kết thúc ngoại lệ).`);
      return;
    }
    const line = (compact.steps[pos] as PStep).n;
    const kind = "choice" in stop.expect ? "choice" : "line_next" in stop.expect ? "line" : "value";
    if (stop.kind && stop.kind !== kind) {
      errors.push(`${where}: kind="${stop.kind}" không khớp với expect (${kind}).`);
      return;
    }
    if ("choice" in stop.expect) {
      if (stop.expect.answer >= stop.expect.choice.length) {
        errors.push(`${where}: answer=${stop.expect.answer} vượt quá số lựa chọn (${stop.expect.choice.length}).`);
        return;
      }
    } else if ("line_next" in stop.expect) {
      if ((compact.steps[post] as PStep).e !== "l") {
        errors.push(`${where}: dòng ${line} kết thúc hàm hoặc gây lỗi nên không có "dòng kế tiếp" (line_next).`);
        return;
      }
    } else {
      const src = stop.expect.expr;
      const e = parseExpr(src);
      if (!e) {
        errors.push(`${where}: expect.expr "${src}" không hợp lệ (chỉ tên biến, probe, len(<tên>) hoặc return).`);
        return;
      }
      if (model.evalAt(post, src) === undefined) {
        const here = Object.keys(model.frameState(post).vars).filter((n) => !n.startsWith("@"));
        const guess = closest(e.name, [...here, "return"]);
        errors.push(
          `${where}: "${src}" không có giá trị sau khi dòng ${line} chạy.${guess ? ` Có phải "${guess}"?` : ""} Biến ở đó: ${here.join(", ") || "(không có)"}${
            (compact.steps[post] as PStep).e === "r" ? ", return" : ""
          }.`,
        );
        return;
      }
    }
    resolved.push({ pos, post, spec: stop, index });
  });
  resolved.sort((a, b) => a.pos - b.pos);
  for (let i = 1; i < resolved.length; i++) {
    if ((resolved[i] as { pos: number }).pos === (resolved[i - 1] as { pos: number }).pos) {
      errors.push(`stops[${(resolved[i] as { index: number }).index}] trùng vị trí với stops[${(resolved[i - 1] as { index: number }).index}] (cùng một dòng và lần chạy).`);
    }
  }
  resolved.forEach((r, i) => {
    const s = r.spec;
    const stop: StopCfg = {
      k: i + 1,
      pos: r.pos,
      post: r.post,
      line: (compact.steps[r.pos] as PStep).n,
      ask: s.ask,
      kind: "choice" in s.expect ? "choice" : "line_next" in s.expect ? "line" : "value",
    };
    if ("expr" in s.expect) stop.expr = s.expect.expr;
    if ("choice" in s.expect) {
      stop.choice = s.expect.choice;
      stop.answer = s.expect.answer;
    }
    if (s.explain) stop.explain = s.explain;
    if (s.tolerance !== undefined) stop.tolerance = s.tolerance;
    data.stops.push(stop);
    stopInfos.push({ k: stop.k, line: stop.line, kind: stop.kind, ask: stop.ask });
  });
  if ((spec.stops ?? []).length === 0) {
    warnings.push("Player chưa có điểm dừng (stops): học viên chỉ xem, không phải dự đoán. Nghiên cứu cho thấy dự đoán mới tạo ra học tập.");
  }
  if (spec.viz.length === 0) warnings.push("Player chưa có viz: chỉ có mã, biến và đầu ra.");

  const outDir = spec.out_dir ? resolve(opts.baseDir ?? process.cwd(), spec.out_dir) : resolve(dirname(tracePath));
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    steps: compact.steps.length,
    stops: stopInfos,
    tracePath,
    outDir,
    data,
    spec,
    trace,
  };
}

export async function checkSpec(rawSpec: unknown, opts: PlanOptions = {}): Promise<CheckResult> {
  const r = await planBuild(rawSpec, opts);
  const { data: _data, spec: _spec, trace: _trace, ...rest } = r;
  void _data;
  void _spec;
  void _trace;
  return rest;
}

/* ───────── HTML ───────── */

function dataScript(data: PlayerData): string {
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    // The page must not contain any external URL: keep learner comments such as "see http://..." inert.
    .replace(/(https?):\/\//gi, (_m, scheme: string) => `${scheme}:\\/\\/`);
  return json;
}

export function renderPlayerHtml(data: PlayerData): string {
  const t = esc(data.meta.title);
  return `<!doctype html>
<html lang="vi" data-theme="${data.meta.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="mira-mcp ${VERSION}">
<meta name="mira-player" content="1">
<meta name="color-scheme" content="dark light">
<title>${t} - Mira</title>
<style>${playerCss}</style>
</head>
<body>
<div id="mira-root"></div>
<noscript><p style="font:16px sans-serif;padding:24px">Trình dò code Mira cần bật JavaScript để chạy.</p></noscript>
<script type="application/json" id="mira-data">${dataScript(data)}</script>
<script>${playerJs}</script>
</body>
</html>
`;
}

export function auroraSlideFor(title: string, indexPath: string, stops: number, steps: number): AuroraSlide {
  return {
    type: "trace",
    eyebrow: "Dò code",
    title,
    player: indexPath,
    caption: `${stops} điểm dừng, ${steps} bước`,
  };
}

export async function buildPlayer(rawSpec: unknown, opts: PlanOptions = {}): Promise<BuildResult> {
  const plan = await planBuild(rawSpec, opts);
  if (!plan.ok || !plan.data || !plan.outDir) {
    return { ...plan, ok: false, text: `Spec chưa hợp lệ:\n- ${plan.errors.join("\n- ")}${plan.warnings.length ? `\n\nCảnh báo:\n- ${plan.warnings.join("\n- ")}` : ""}` };
  }
  const html = renderPlayerHtml(plan.data);
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_HTML_BYTES) {
    const text = `Player vượt giới hạn 3 MB (${(bytes / 1048576).toFixed(2)} MB). Giảm max_steps khi ghi, dùng focus để bớt hàm, hoặc bớt biến lớn.`;
    return { ...plan, ok: false, errors: [...plan.errors, text], text };
  }
  const indexPath = join(plan.outDir, "index.html");
  await atomicWriteFile(indexPath, html);
  notifySmartDrive(plan.outDir);
  const stops = plan.data.stops.length;
  const steps = plan.data.steps.length;
  const auroraSlide = auroraSlideFor(plan.data.meta.title, indexPath, stops, steps);
  const lines: string[] = [];
  lines.push(`# Đã tạo player: ${indexPath}`);
  lines.push(`- Kích thước: ${(bytes / 1024).toFixed(0)} KB · ${steps} bước · ${stops} điểm dừng · ${plan.data.viz.length} viz`);
  lines.push("- Tệp chạy hoàn toàn ngoại tuyến (không CDN). Mở trực tiếp hoặc dùng mira_preview để ghi tiến độ vào progress.jsonl.");
  if (plan.data.stops.length) {
    lines.push("", "Điểm dừng (chỉ câu hỏi, không có đáp án):");
    for (const s of plan.data.stops) lines.push(`${s.k}. [dòng ${s.line}] ${s.ask}`);
  }
  for (const w of plan.warnings) lines.push(`- Cảnh báo: ${w}`);
  lines.push("", "Slide cho Aurora (dán vào deck, Mira không tự ghi vào thư mục deck):", "```json", JSON.stringify(auroraSlide, null, 2), "```");
  return { ...plan, indexPath, bytes, auroraSlide, text: lines.join("\n") };
}
