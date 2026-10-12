import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { type LabRef, readLab } from "./lab.js";
import { resolvePython, runProcessWithTimeout } from "./python.js";
import {
  type LineEvent,
  type RecordParams,
  RecordParamsSchema,
  type Trace,
  type TraceEvent,
  formatZodErrors,
  recordShape,
  validateTrace,
} from "./schema.js";
import { notifySmartDrive } from "./smartdrive.js";
import { TRACER_PY } from "./tracer_py.js";
import { atomicWriteFile, errMsg, slugify, truncate } from "./util.js";

export interface StopSuggestion {
  at: { line: number; hit: number };
  ask: string;
  expect: { expr: string } | { line_next: true };
  why: string;
}

export interface RecordSummary {
  events: number;
  lineEvents: number;
  functions: Array<{ name: string; calls: number }>;
  hotLines: Array<{ line: number; count: number; text: string }>;
  variables: Array<{ name: string; types: string[] }>;
  stdoutHead: string;
  suggestedStops: StopSuggestion[];
}

export interface RecordResult {
  ok: boolean;
  tracePath?: string;
  outDir?: string;
  trace?: Trace;
  timedOut: boolean;
  summary?: RecordSummary;
  warnings: string[];
  /** Vietnamese reply for the learner / agent. */
  text: string;
}

const DEFAULT_MAX_STEPS = 2000;
const DEFAULT_TIMEOUT_SEC = 10;

/** Resolves the file to trace from `file` and/or an Orion lab. */
export async function resolveTarget(file: string | undefined, labDir: string | undefined): Promise<{ file: string; lab?: LabRef }> {
  let lab: LabRef | undefined;
  if (labDir) lab = await readLab(labDir);
  let target: string;
  if (file) target = isAbsolute(file) ? file : lab ? join(lab.dir, file) : resolve(file);
  else if (lab) target = lab.entryPath;
  else throw new Error("Cần `file` (đường dẫn tệp .py) hoặc `lab` (thư mục bài lab của Orion).");
  target = resolve(target);
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`Không tìm thấy tệp: ${target}`);
  if (extname(target).toLowerCase() !== ".py") throw new Error(`Mira chỉ dò tệp Python (.py), nhận được: ${basename(target)}`);
  return lab ? { file: target, lab } : { file: target };
}

export function defaultOutDir(file: string, call: string | undefined): string {
  const stem = basename(file, extname(file));
  return join(dirname(file), "mira", slugify(`${stem}-${call ?? "script"}`));
}

export async function recordTrace(rawInput: unknown): Promise<RecordResult> {
  const parsed = RecordParamsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`Tham số mira_record không hợp lệ:\n- ${formatZodErrors(parsed.error.issues, recordShape).join("\n- ")}`);
  }
  const input: RecordParams = parsed.data;
  const hasCall = input.call !== undefined;
  const isScript = input.script === true;
  if (hasCall === isScript) {
    return fail("Cần đúng một trong `call` (biểu thức gọi hàm, ví dụ tong_chu_so(-4567)) hoặc `script: true` (chạy cả tệp như __main__).");
  }
  const target = await resolveTarget(input.file, input.lab);
  const maxSteps = input.max_steps ?? DEFAULT_MAX_STEPS;
  const timeoutSec = input.timeout_sec ?? DEFAULT_TIMEOUT_SEC;
  const outDir = resolve(input.out_dir ?? defaultOutDir(target.file, input.call));
  const python = resolvePython();

  const runDir = await mkdtemp(join(tmpdir(), "mira-run-"));
  try {
    const tracerPath = join(runDir, "tracer.py");
    const paramsPath = join(runDir, "params.json");
    const outPath = join(runDir, "trace.json");
    await writeFile(tracerPath, TRACER_PY, "utf8");
    const params: Record<string, unknown> = {
      file: target.file,
      max_steps: maxSteps,
      timeout_sec: timeoutSec,
      out: outPath,
    };
    if (input.call !== undefined) params.call = input.call;
    if (isScript) params.script = true;
    if (input.focus?.length) params.focus = input.focus;
    if (input.probes) params.probes = input.probes;
    if (input.stdin !== undefined) params.stdin = input.stdin;
    if (input.name) params.name = input.name;
    if (target.lab) {
      params.lab = {
        path: target.lab.dir,
        title: target.lab.title,
        ...(target.lab.subject ? { subject: target.lab.subject } : {}),
        ...(target.lab.module ? { module: target.lab.module } : {}),
      };
    }
    await writeFile(paramsPath, JSON.stringify(params), "utf8");

    const outcome = await runProcessWithTimeout(python.cmd, [...python.args, "-B", "-X", "utf8", tracerPath, paramsPath], {
      cwd: dirname(target.file),
      timeoutMs: timeoutSec * 1000,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        PYTHONHASHSEED: process.env.PYTHONHASHSEED ?? "0",
      },
    });

    let rawText: string | undefined;
    try {
      rawText = await readFile(outPath, "utf8");
    } catch {
      rawText = undefined;
    }

    if (rawText === undefined) {
      if (outcome.timedOut) {
        return fail(
          `Hết thời gian (${timeoutSec}s): chương trình chạy quá lâu hoặc lặp vô hạn trước khi ghi được vết nào. ` +
            "Kiểm tra điều kiện dừng của vòng lặp, thêm `focus` để chỉ dò hàm bị nghi ngờ, hoặc giảm max_steps.",
        );
      }
      const tail = truncate(outcome.stderr.trim().split(/\r?\n/).slice(-8).join("\n"), 1200);
      return fail(`Trình dò (Python) không tạo được vết (mã thoát ${outcome.exitCode}).${tail ? `\n${tail}` : ""}`);
    }

    let trace: Trace;
    try {
      trace = validateTrace(JSON.parse(rawText), "trace");
    } catch (e) {
      return fail(`Vết ghi ra không hợp lệ: ${errMsg(e)}`);
    }
    if (outcome.timedOut) {
      trace.timedOut = true;
      trace.error = {
        type: "TimeoutError",
        message: `Hết thời gian sau ${timeoutSec}s: chương trình bị dừng (có thể lặp vô hạn).`,
        traceback: "",
        timeout: true,
      };
    }

    await mkdir(outDir, { recursive: true });
    const tracePath = join(outDir, "trace.json");
    await atomicWriteFile(tracePath, outcome.timedOut ? JSON.stringify(trace) : rawText);
    notifySmartDrive(outDir);

    const summary = summarizeTrace(trace);
    const warnings = traceWarnings(trace, input.focus);
    const text = formatRecordReply(trace, summary, warnings, tracePath, timeoutSec);
    return { ok: !outcome.timedOut, tracePath, outDir, trace, timedOut: outcome.timedOut, summary, warnings, text };
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function fail(text: string): RecordResult {
  return { ok: false, timedOut: false, warnings: [], text };
}

/* ───────── analysis helpers (shared with the drill) ───────── */

export function lineEvents(trace: Trace): LineEvent[] {
  return trace.steps.filter((s): s is LineEvent => s.ev === "line");
}

/** Index of the next event of the same frame for every event (or -1). */
export function nextInFrame(steps: TraceEvent[]): Int32Array {
  const next = new Int32Array(steps.length).fill(-1);
  const last = new Map<number, number>();
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k] as TraceEvent;
    if (s.ev === "call") continue;
    const prev = last.get(s.fid);
    if (prev !== undefined) next[prev] = k;
    last.set(s.fid, k);
  }
  return next;
}

export interface Accumulator {
  line: number;
  name: string;
  /** hit numbers (1-based occurrence of `line`) at which the name changed afterwards */
  hits: number[];
}

/** Variables updated by the same line several times (loop accumulators): (line, name) with >= 2 updates. */
export function findAccumulators(trace: Trace): Accumulator[] {
  const steps = trace.steps;
  const next = nextInFrame(steps);
  const hitNo = new Map<number, number>();
  const groups = new Map<string, Accumulator>();
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k] as TraceEvent;
    if (s.ev !== "line") continue;
    const hit = (hitNo.get(s.line) ?? 0) + 1;
    hitNo.set(s.line, hit);
    const nk = next[k] as number;
    if (nk < 0) continue;
    const n = steps[nk] as TraceEvent;
    if (n.ev !== "line") continue;
    for (const name of n.changed) {
      if (n.fid !== s.fid) continue;
      const key = `${s.line}:${name}`;
      let g = groups.get(key);
      if (!g) {
        g = { line: s.line, name, hits: [] };
        groups.set(key, g);
      }
      g.hits.push(hit);
    }
  }
  return [...groups.values()].filter((g) => g.hits.length >= 2).sort((a, b) => b.hits.length - a.hits.length || a.line - b.line);
}

function codeOf(trace: Trace, line: number, max = 60): string {
  return truncate((trace.source[line - 1] ?? "").trim(), max);
}

const BRANCH_RE = /^(if|elif|else|while|for)\b/;

/** Heuristic stop suggestions: accumulator updates, returns, and branch decisions. */
export function suggestStops(trace: Trace, max = 6): StopSuggestion[] {
  const steps = trace.steps;
  const next = nextInFrame(steps);
  const out: StopSuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: StopSuggestion) => {
    const key = `${s.at.line}:${s.at.hit}:${JSON.stringify(s.expect)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  };

  // 1. first and last update of the busiest accumulator inside a loop
  const accs = findAccumulators(trace).filter((a) => !a.name.startsWith("@"));
  const best = accs[0];
  if (best) {
    const first = best.hits[0] as number;
    const last = best.hits[best.hits.length - 1] as number;
    push({
      at: { line: best.line, hit: first },
      ask: `Sau khi dòng ${best.line} (\`${codeOf(trace, best.line)}\`) chạy lần đầu, \`${best.name}\` bằng bao nhiêu?`,
      expect: { expr: best.name },
      why: "lần cập nhật đầu tiên của biến tích luỹ trong vòng lặp",
    });
    if (last !== first) {
      push({
        at: { line: best.line, hit: last },
        ask: `Sau khi dòng ${best.line} chạy lần thứ ${last}, \`${best.name}\` bằng bao nhiêu?`,
        expect: { expr: best.name },
        why: "lần cập nhật cuối cùng của biến tích luỹ",
      });
    }
  }

  // 2. the line holding each return (ask for the returned value)
  const returnAsk: StopSuggestion[] = [];
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k] as TraceEvent;
    if (s.ev !== "return") continue;
    let p = -1;
    for (let j = k - 1; j >= 0; j--) {
      const q = steps[j] as TraceEvent;
      if (q.fid === s.fid && q.ev === "line") {
        p = j;
        break;
      }
    }
    if (p < 0) continue;
    const pe = steps[p] as LineEvent;
    if (!/^\s*return\b/.test(trace.source[pe.line - 1] ?? "")) continue;
    // hit number of that line event
    let hit = 0;
    for (let j = 0; j <= p; j++) {
      const q = steps[j] as TraceEvent;
      if (q.ev === "line" && q.line === pe.line) hit++;
    }
    returnAsk.push({
      at: { line: pe.line, hit },
      ask: `Hàm \`${s.func}\` trả về giá trị gì ở dòng ${pe.line} (\`${codeOf(trace, pe.line)}\`)?`,
      expect: { expr: "return" },
      why: "dòng chứa return",
    });
  }
  const lastReturn = returnAsk[returnAsk.length - 1];
  if (lastReturn) push(lastReturn);

  // 3. branch decisions: which line runs next after an if / elif / while / for header
  let branches = 0;
  const hitBranch = new Map<number, number>();
  for (let k = 0; k < steps.length && branches < 2; k++) {
    const s = steps[k] as TraceEvent;
    if (s.ev !== "line") continue;
    const h = (hitBranch.get(s.line) ?? 0) + 1;
    hitBranch.set(s.line, h);
    if (!/^(if|elif)\b/.test((trace.source[s.line - 1] ?? "").trim())) continue;
    const nk = next[k] as number;
    if (nk < 0 || (steps[nk] as TraceEvent).ev !== "line") continue;
    push({
      at: { line: s.line, hit: h },
      ask: `Sau dòng ${s.line} (\`${codeOf(trace, s.line)}\`), dòng nào chạy tiếp theo?`,
      expect: { line_next: true },
      why: "rẽ nhánh: dòng kế tiếp phụ thuộc điều kiện",
    });
    branches++;
  }

  // 4. a middle iteration of the accumulator, when there is room
  if (best && out.length < max && best.hits.length >= 3) {
    const mid = best.hits[Math.floor(best.hits.length / 2)] as number;
    push({
      at: { line: best.line, hit: mid },
      ask: `Sau khi dòng ${best.line} chạy lần thứ ${mid}, \`${best.name}\` bằng bao nhiêu?`,
      expect: { expr: best.name },
      why: "một vòng lặp ở giữa",
    });
  }
  return out.slice(0, max).sort((a, b) => a.at.line - b.at.line || a.at.hit - b.at.hit);
}

export function summarizeTrace(trace: Trace): RecordSummary {
  const calls = new Map<string, number>();
  const lineCount = new Map<number, number>();
  const vars = new Map<string, Set<string>>();
  let lineEventsN = 0;
  for (const s of trace.steps) {
    if (s.ev === "call") calls.set(s.func, (calls.get(s.func) ?? 0) + 1);
    if (s.ev === "line") {
      lineEventsN++;
      lineCount.set(s.line, (lineCount.get(s.line) ?? 0) + 1);
      for (const [name, t] of Object.entries(s.types)) {
        let set = vars.get(name);
        if (!set) {
          set = new Set();
          vars.set(name, set);
        }
        set.add(t);
      }
    }
  }
  const hotLines = [...lineCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 15)
    .map(([line, count]) => ({ line, count, text: codeOf(trace, line, 70) }));
  const lines = trace.stdout.split(/\r?\n/);
  const stdoutHead = truncate(lines.slice(0, 8).join("\n"), 600);
  return {
    events: trace.steps.length,
    lineEvents: lineEventsN,
    functions: [...calls.entries()].map(([name, n]) => ({ name, calls: n })),
    hotLines,
    variables: [...vars.entries()].map(([name, set]) => ({ name, types: [...set] })),
    stdoutHead,
    suggestedStops: suggestStops(trace),
  };
}

function traceWarnings(trace: Trace, focusRequested: string[] | undefined): string[] {
  const warnings: string[] = [];
  if (trace.truncated) {
    warnings.push(`Vết bị cắt ở ${trace.stats?.lineEvents ?? "?"} dòng (đạt max_steps); chương trình vẫn chạy tiếp nhưng không ghi thêm.`);
  }
  if (trace.tracerError) warnings.push(`Trình dò gặp lỗi nội bộ và dừng ghi: ${trace.tracerError}`);
  for (const e of trace.probeErrors ?? []) warnings.push(`Probe không biên dịch được: ${e}`);
  if (focusRequested?.length) {
    const entered = new Set(trace.steps.filter((s) => s.ev === "call").map((s) => s.func));
    const missing = focusRequested.filter((f) => !entered.has(f));
    if (missing.length) warnings.push(`Hàm trong focus chưa bao giờ được gọi: ${missing.join(", ")}`);
  }
  if (!trace.steps.some((s) => s.ev === "line") && !trace.error) {
    warnings.push("Không có dòng nào được ghi: kiểm tra `focus` hoặc biểu thức `call`.");
  }
  return warnings;
}

function formatRecordReply(trace: Trace, summary: RecordSummary, warnings: string[], tracePath: string, timeoutSec: number): string {
  const what = trace.call ? trace.call : "chạy cả tệp (script)";
  const lines: string[] = [];
  lines.push(`# Đã dò: ${basename(trace.file)} · ${what}`);
  lines.push(`- Tệp vết: ${tracePath}`);
  lines.push(
    `- Số sự kiện: ${summary.events} (${summary.lineEvents} dòng chạy)${trace.truncated ? " - BỊ CẮT" : ""} · Python ${trace.python}`,
  );
  if (trace.timedOut) {
    lines.push(`- LỖI: hết thời gian ${timeoutSec}s, chương trình bị dừng. Vết một phần đã lưu để xem dòng nào lặp.`);
  } else if (trace.error) {
    lines.push(`- Lỗi khi chạy: ${trace.error.type}: ${trace.error.message}${trace.error.line ? ` (dòng ${trace.error.line})` : ""}`);
  } else if (trace.result !== undefined) {
    lines.push(`- Kết quả: ${trace.result}`);
  }
  if (summary.functions.length) {
    lines.push(`- Hàm đã vào: ${summary.functions.map((f) => `${f.name} x${f.calls}`).join(", ")}`);
  }
  if (summary.hotLines.length) {
    lines.push("- Dòng chạy nhiều nhất:");
    for (const h of summary.hotLines.slice(0, 15)) lines.push(`  - dòng ${h.line}: ${h.count} lần  ${h.text}`);
  }
  if (summary.variables.length) {
    lines.push(`- Biến đã thấy: ${summary.variables.map((v) => `${v.name} (${v.types.join("/")})`).join(", ")}`);
  }
  if (summary.stdoutHead.trim()) lines.push(`- Đầu ra (stdout):\n${summary.stdoutHead.split("\n").map((l) => `  ${l}`).join("\n")}`);
  for (const w of warnings) lines.push(`- Cảnh báo: ${w}`);
  if (summary.suggestedStops.length) {
    lines.push("", "Gợi ý điểm dừng (chép vào `stops` của spec, sửa câu hỏi cho hợp bài):", "```json");
    lines.push(
      JSON.stringify(
        summary.suggestedStops.map((s) => ({ at: s.at, ask: s.ask, expect: s.expect })),
        null,
        2,
      ),
    );
    lines.push("```");
  }
  lines.push("", "Bước tiếp theo: viết spec build (1-3 viz, counters, 3-8 stops) -> mira_check -> mira_build.");
  return lines.join("\n");
}
