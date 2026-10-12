/**
 * mira_drill: one call that records a learner's function and builds an exam-practice player with prediction stops.
 * Mira traces code that exists; it refuses functions that still contain fill-in placeholders (___1___).
 */
import { basename } from "node:path";
import { type AuroraSlide, buildPlayer } from "./build.js";
import { highlightSource } from "./highlight.js";
import { fromVal, parsePy, valuesEqual } from "./player/compare.js";
import { type Accumulator, defaultOutDir, findAccumulators, nextInFrame, recordTrace, resolveTarget } from "./record.js";
import { type BuildSpecInput, type DrillParams, DrillParamsSchema, type Trace, drillShape, formatZodErrors } from "./schema.js";
import { closest, truncate } from "./util.js";
import { readFile } from "node:fs/promises";

/* ───────── a small Python function parser (indentation based) ───────── */

export interface PyFunction {
  name: string;
  /** 1-based line of `def` */
  line: number;
  /** 1-based last line of the body */
  endLine: number;
  indent: number;
  params: string[];
  doc?: string;
  nested: string[];
  text: string;
}

const DEF_RE = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([\p{L}_][\p{L}\p{N}_]*)[ \t]*\(/u;

function indentOf(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** Finds where the header of a def (starting at line index i) ends: index of the line holding the closing colon. */
function headerEnd(lines: string[], i: number): { end: number; params: string[]; inlineBody: boolean } | undefined {
  let depth = 0;
  let opened = false;
  let quote = "";
  let paramText = "";
  let collecting = false;
  for (let li = i; li < Math.min(lines.length, i + 40); li++) {
    const line = lines[li] as string;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci] as string;
      if (quote) {
        if (ch === "\\") ci++;
        else if (ch === quote) quote = "";
        if (collecting) paramText += ch;
        continue;
      }
      if (ch === "#") break;
      if (ch === "'" || ch === '"') {
        quote = ch;
        if (collecting) paramText += ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        if (!opened && ch === "(") {
          opened = true;
          collecting = true;
          continue;
        }
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (collecting && depth === 0) {
          collecting = false;
          continue;
        }
      } else if (ch === ":" && opened && depth === 0) {
        const rest = line.slice(ci + 1).replace(/#.*$/, "").trim();
        return { end: li, params: splitParams(paramText), inlineBody: rest.length > 0 };
      }
      if (collecting) paramText += ch;
    }
    if (collecting) paramText += " ";
  }
  return undefined;
}

function splitParams(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = "";
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if ("([{".includes(ch)) {
      depth++;
      cur += ch;
    } else if (")]}".includes(ch)) {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts
    .map((p) => p.trim().replace(/^\*+/, "").split(/[:=]/)[0]!.trim())
    .filter((p) => p && p !== "/" && p !== "*" && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(p));
}

export function parsePyFunctions(source: string[]): PyFunction[] {
  const { inString } = highlightSource(source);
  const out: PyFunction[] = [];
  for (let i = 0; i < source.length; i++) {
    if (inString[i]) continue;
    const line = source[i] as string;
    const m = DEF_RE.exec(line);
    if (!m) continue;
    const indent = indentOf(m[1] as string);
    const hdr = headerEnd(source, i);
    if (!hdr) continue;
    let last = hdr.end;
    if (!hdr.inlineBody) {
      for (let k = hdr.end + 1; k < source.length; k++) {
        const l = source[k] as string;
        const t = l.trim();
        if (t === "") continue;
        if (inString[k]) {
          last = k;
          continue;
        }
        if (t.startsWith("#")) continue;
        if (indentOf(l) <= indent) break;
        last = k;
      }
    }
    // docstring: first statement of the body
    let doc: string | undefined;
    for (let k = hdr.end + (hdr.inlineBody ? 0 : 1); k <= last && k < source.length; k++) {
      const t = (source[k] as string).trim();
      if (t === "" || t.startsWith("#")) continue;
      const dm = /^[rRuUbBfF]{0,2}("""|'''|"|')/.exec(t);
      if (dm) {
        const q = dm[1] as string;
        const afterOpen = t.slice(dm[0].length);
        if (q.length === 3) {
          const closeAt = afterOpen.indexOf(q);
          if (closeAt >= 0) doc = afterOpen.slice(0, closeAt);
          else {
            const parts = [afterOpen];
            for (let j = k + 1; j <= last; j++) {
              const lj = source[j] as string;
              const c = lj.indexOf(q);
              if (c >= 0) {
                parts.push(lj.slice(0, c));
                break;
              }
              parts.push(lj);
            }
            doc = parts.join("\n");
          }
        } else {
          const closeAt = afterOpen.indexOf(q);
          doc = closeAt >= 0 ? afterOpen.slice(0, closeAt) : afterOpen;
        }
      }
      break;
    }
    const nested: string[] = [];
    for (let k = hdr.end + 1; k <= last; k++) {
      if (inString[k]) continue;
      const nm = DEF_RE.exec(source[k] as string);
      if (nm && indentOf(nm[1] as string) > indent) nested.push(nm[2] as string);
    }
    const fn: PyFunction = {
      name: m[2] as string,
      line: i + 1,
      endLine: last + 1,
      indent,
      params: hdr.params,
      nested,
      text: source.slice(i, last + 1).join("\n"),
    };
    if (doc !== undefined) fn.doc = doc;
    out.push(fn);
  }
  return out;
}

/* ───────── docstring examples ───────── */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface DocExample {
  call: string;
  expected: string;
  /** "call" for f(args) -> result, "args" for args -> result */
  form: "call" | "args";
}

export function docExamples(doc: string, fnName: string): DocExample[] {
  const found: Array<DocExample & { at: number }> = [];
  const reA = new RegExp(`(?<![\\w.])(${escapeRe(fnName)}\\s*\\((?:[^()\\n]|\\([^()\\n]*\\))*\\))\\s*(?:->|==|→)\\s*([^\\n;]+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = reA.exec(doc)) !== null) {
    found.push({ call: (m[1] as string).trim(), expected: (m[2] as string).trim().replace(/[,]+$/, ""), form: "call", at: m.index });
  }
  if (found.length > 0) return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...rest }) => rest);
  // fallback: "<args> -> <result>" lines (several examples may share a line, separated by ;)
  let offset = 0;
  const fallback: Array<DocExample & { at: number }> = [];
  for (const rawLine of doc.split("\n")) {
    for (const seg of rawLine.split(/\s;\s|;\s/)) {
      const lm = /^\s*(.+?)\s*(?:->|→)\s*(.+?)\s*$/.exec(seg);
      if (lm) {
        const left = lm[1] as string;
        if (/^["'[({\-\d]/.test(left) || /^[\p{L}_][\p{L}\p{N}_]*\s*=/u.test(left)) {
          if (!new RegExp(`${escapeRe(fnName)}\\s*\\(`).test(left)) {
            fallback.push({ call: `${fnName}(${left})`, expected: (lm[2] as string).trim(), form: "args", at: offset });
          }
        }
      }
    }
    offset += rawLine.length + 1;
  }
  return fallback.sort((a, b) => a.at - b.at).map(({ at: _at, ...rest }) => rest);
}

/* ───────── stop selection ───────── */

function hitNumbers(trace: Trace): Int32Array {
  const hits = new Int32Array(trace.steps.length);
  const seen = new Map<number, number>();
  trace.steps.forEach((s, k) => {
    if (s.ev !== "line") return;
    const n = (seen.get(s.line) ?? 0) + 1;
    seen.set(s.line, n);
    hits[k] = n;
  });
  return hits;
}

function pickSpread(hits: number[], n: number): number[] {
  if (n <= 0 || hits.length === 0) return [];
  if (hits.length <= n) return hits.slice();
  if (n === 1) return [hits[0] as number];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(hits[Math.round((i * (hits.length - 1)) / (n - 1))] as number);
  return [...new Set(out)];
}

const code = (trace: Trace, line: number, max = 56): string => truncate((trace.source[line - 1] ?? "").trim(), max);

export function planDrillStops(trace: Trace, fnName: string, count: number, docNote?: string): NonNullable<BuildSpecInput["stops"]> {
  const steps = trace.steps;
  const hitNo = hitNumbers(trace);
  const stops: NonNullable<BuildSpecInput["stops"]> = [];
  const used = new Set<string>();
  const add = (line: number, hit: number, stop: Omit<NonNullable<BuildSpecInput["stops"]>[number], "at">): boolean => {
    const key = `${line}:${hit}`;
    if (used.has(key) || stops.length >= count) return false;
    used.add(key);
    stops.push({ at: { line, hit }, ...stop });
    return true;
  };

  // 1. the line holding the final return: ask for the returned value
  let lastReturn = -1;
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k]!;
    if (s.ev === "return" && s.depth === 1) lastReturn = k;
  }
  if (lastReturn >= 0) {
    const r = steps[lastReturn]!;
    for (let j = lastReturn - 1; j >= 0; j--) {
      const q = steps[j]!;
      if (q.fid === r.fid && q.ev === "line") {
        if (/^\s*return\b/.test(trace.source[q.line - 1] ?? "")) {
          add(q.line, hitNo[j] as number, {
            ask: `Hàm \`${fnName}\` trả về giá trị gì ở dòng ${q.line} (\`${code(trace, q.line)}\`)?`,
            expect: { expr: "return" },
            explain: `Đây là kết quả cuối cùng của ${trace.call ?? fnName}.${docNote ? ` ${docNote}` : ""}`,
          });
        }
        break;
      }
    }
  }

  // 2. accumulator updates inside loops: first, middle and last iteration
  const accs: Accumulator[] = findAccumulators(trace).filter((a) => !a.name.startsWith("@"));
  const remaining = Math.max(0, count - stops.length);
  const best = accs[0];
  if (best && remaining > 0) {
    const want = Math.min(remaining, best.hits.length, Math.max(1, remaining));
    const chosen = pickSpread(best.hits, Math.min(want, 3 + Math.max(0, remaining - 3)));
    chosen.forEach((hit, idx) => {
      const ordinal = hit === best.hits[0] ? "lần đầu" : hit === best.hits[best.hits.length - 1] ? `lần cuối (lần thứ ${hit})` : `lần thứ ${hit}`;
      add(best.line, hit, {
        ask:
          idx === 0
            ? `Sau khi dòng ${best.line} (\`${code(trace, best.line)}\`) chạy ${ordinal}, \`${best.name}\` bằng bao nhiêu?`
            : `Sau khi dòng ${best.line} chạy ${ordinal}, \`${best.name}\` bằng bao nhiêu?`,
        expect: { expr: best.name },
        explain: "Dòng này cập nhật biến tích luỹ trong vòng lặp; hãy lần theo giá trị trước đó rồi cộng thêm phần mới.",
      });
    });
  }
  // other accumulators if more stops are wanted
  for (const a of accs.slice(1)) {
    if (stops.length >= count) break;
    const first = a.hits[0] as number;
    add(a.line, first, {
      ask: `Sau khi dòng ${a.line} (\`${code(trace, a.line)}\`) chạy lần đầu, \`${a.name}\` bằng bao nhiêu?`,
      expect: { expr: a.name },
    });
    const last = a.hits[a.hits.length - 1] as number;
    if (last !== first) {
      add(a.line, last, {
        ask: `Sau khi dòng ${a.line} chạy lần thứ ${last}, \`${a.name}\` bằng bao nhiêu?`,
        expect: { expr: a.name },
      });
    }
  }

  // 3. no loops: single assignments spread over the function
  if (stops.length < count) {
    const next = nextInFrame(steps);
    const picks: Array<{ line: number; hit: number; name: string }> = [];
    const seenLines = new Set<number>();
    for (let k = 0; k < steps.length; k++) {
      const s = steps[k]!;
      if (s.ev !== "line") continue;
      const nk = next[k] as number;
      if (nk < 0) continue;
      const n = steps[nk]!;
      if (n.ev !== "line" || seenLines.has(s.line)) continue;
      const name = n.changed.find((c) => !c.startsWith("@"));
      if (!name) continue;
      seenLines.add(s.line);
      picks.push({ line: s.line, hit: hitNo[k] as number, name });
    }
    for (const p of pickSpread(picks.map((_, i) => i), count - stops.length)) {
      const pick = picks[p]!;
      add(pick.line, pick.hit, {
        ask: `Sau khi dòng ${pick.line} (\`${code(trace, pick.line)}\`) chạy, \`${pick.name}\` bằng bao nhiêu?`,
        expect: { expr: pick.name },
      });
    }
  }
  return stops;
}

/* ───────── viz and counters ───────── */

const LISTY = new Set(["list", "tuple", "deque", "ndarray"]);
const INDEX_NAMES = ["i", "j", "k", "idx", "index", "lo", "hi", "left", "right", "mid", "l", "r"];

function chooseViz(trace: Trace): NonNullable<BuildSpecInput["viz"]> {
  const viz: NonNullable<BuildSpecInput["viz"]> = [];
  const call = trace.steps.find((s) => s.ev === "call");
  const types = new Map<string, string>();
  const order: string[] = [];
  const note = (name: string, t: string): void => {
    if (name.startsWith("@")) return;
    if (!types.has(name)) order.push(name);
    types.set(name, t);
  };
  if (call && call.ev === "call") for (const [n, t] of Object.entries(call.types)) note(n, t);
  for (const s of trace.steps) if (s.ev === "line") for (const [n, t] of Object.entries(s.types)) if (!types.has(n)) note(n, t);
  const list = order.find((n) => LISTY.has(types.get(n) ?? ""));
  const dict = order.find((n) => ["dict", "OrderedDict", "defaultdict", "Counter"].includes(types.get(n) ?? ""));
  if (list) {
    const pointers = order.filter((n) => INDEX_NAMES.includes(n) && types.get(n) === "int").slice(0, 3);
    viz.push({ kind: "array", var: list, ...(pointers.length ? { pointers } : {}) });
  }
  if (dict) viz.push({ kind: "table", var: dict });
  return viz;
}

function chooseCounters(trace: Trace, fn: PyFunction, acc: Accumulator | undefined): NonNullable<BuildSpecInput["counters"]> {
  const counters: NonNullable<BuildSpecInput["counters"]> = [];
  // Count iterations by the first line of the loop body (the header also runs once more to fail the test).
  let bodyLine = 0;
  for (let l = fn.line; l <= fn.endLine && !bodyLine; l++) {
    const src = trace.source[l - 1] ?? "";
    if (!/^\s*(for|while)\b/.test(src) || (trace.lines[String(l)] ?? 0) < 2) continue;
    const headerIndent = indentOf(src);
    for (let b = l + 1; b <= fn.endLine; b++) {
      const t = (trace.source[b - 1] ?? "").trim();
      if (t === "" || t.startsWith("#")) continue;
      if (indentOf(trace.source[b - 1] as string) > headerIndent && (trace.lines[String(b)] ?? 0) >= 1) bodyLine = b;
      break;
    }
  }
  if (bodyLine) counters.push({ label: "Vòng lặp", line_hits: bodyLine });
  if (acc && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(acc.name)) counters.push({ label: acc.name, expr: acc.name });
  return counters;
}

/* ───────── main entry ───────── */

export interface DrillResult {
  ok: boolean;
  indexPath?: string;
  tracePath?: string;
  outDir?: string;
  call?: string;
  stops: Array<{ k: number; line: number; kind: string; ask: string }>;
  auroraSlide?: AuroraSlide;
  warnings: string[];
  text: string;
}

export async function runDrill(rawInput: unknown): Promise<DrillResult> {
  const parsed = DrillParamsSchema.safeParse(rawInput);
  if (!parsed.success) {
    return failDrill(`Tham số mira_drill không hợp lệ:\n- ${formatZodErrors(parsed.error.issues, drillShape).join("\n- ")}`);
  }
  const input: DrillParams = parsed.data;
  const target = await resolveTarget(input.file, input.lab);
  const source = (await readFile(target.file, "utf8")).replace(/^﻿/, "").split(/\r\n|\r|\n/);
  if (source[source.length - 1] === "") source.pop();
  const functions = parsePyFunctions(source);
  const names = functions.map((f) => f.name);

  let fnName = input.function;
  if (!fnName && input.call) fnName = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*\(/u.exec(input.call)?.[1];
  if (!fnName) {
    const top = functions.filter((f) => f.indent === 0);
    if (top.length === 1) fnName = top[0]!.name;
    else return failDrill(`Cần chỉ rõ \`function\` hoặc \`call\`. Các hàm trong ${basename(target.file)}: ${names.join(", ") || "(không có)"}.`);
  }
  const fn = functions.find((f) => f.name === fnName);
  if (!fn) {
    const guess = closest(fnName, names);
    return failDrill(`Không tìm thấy hàm "${fnName}" trong ${basename(target.file)}.${guess ? ` Có phải "${guess}"?` : ""} Các hàm: ${names.join(", ") || "(không có)"}.`);
  }

  // refuse fill-in exercises: Mira traces code that exists, it never writes the answer
  const ph = /___\d+___/.exec(fn.text);
  if (ph) {
    const lineNo = fn.line + fn.text.slice(0, ph.index).split("\n").length - 1;
    return failDrill(`Hoàn thành chỗ trống trước khi dò code. (Hàm ${fn.name} còn ${ph[0]} ở dòng ${lineNo}.)`);
  }

  let call = input.call;
  let docExpected: string | undefined;
  let derived = false;
  if (!call) {
    const ex = fn.doc ? docExamples(fn.doc, fn.name)[0] : undefined;
    if (!ex) {
      return failDrill(
        `Không tìm thấy ví dụ dạng \`${fn.name}(args) -> kết quả\` hoặc \`${fn.name}(args) == kết quả\` trong docstring của ${fn.name}. Hãy truyền \`call\`, ví dụ: ${fn.name}(...).`,
      );
    }
    call = ex.call;
    docExpected = ex.expected;
    derived = true;
  } else if (fn.doc) {
    const same = docExamples(fn.doc, fn.name).find((e) => e.call.replace(/\s+/g, "") === call!.replace(/\s+/g, ""));
    docExpected = same?.expected;
  }

  const outDir = input.out_dir ?? defaultOutDir(target.file, call);
  const rec = await recordTrace({
    file: target.file,
    ...(target.lab ? { lab: target.lab.dir } : {}),
    call,
    focus: [fn.name, ...fn.nested],
    out_dir: outDir,
    max_steps: 2000,
    timeout_sec: 20,
  });
  if (!rec.trace || !rec.tracePath) return failDrill(rec.text);
  if (rec.timedOut) return failDrill(`Hết thời gian khi dò ${call}: hàm có thể lặp vô hạn. Kiểm tra điều kiện dừng của vòng lặp.`);
  const trace = rec.trace;
  if (!trace.steps.some((s) => s.ev === "line")) {
    return failDrill(
      `Không ghi được dòng nào của ${fn.name}.${trace.error ? ` Chương trình báo ${trace.error.type}: ${trace.error.message}.` : ""}${
        derived ? ` Biểu thức call lấy từ docstring (${call}); nếu sai, hãy truyền \`call\`.` : ""
      }`,
    );
  }

  const warnings = [...rec.warnings];
  let docNote: string | undefined;
  if (docExpected !== undefined) {
    const exp = parsePy(docExpected);
    if (exp.ok && trace.resultValue !== undefined) {
      const same = valuesEqual(exp.value, fromVal(trace.resultValue));
      if (!same) warnings.push(`Kết quả thực tế ${trace.result ?? "?"} khác ví dụ trong docstring (${docExpected.trim()}): có thể hàm chưa đúng.`);
      else docNote = `Khớp ví dụ trong docstring: ${call} -> ${docExpected.trim()}.`;
    }
  }

  const stops = planDrillStops(trace, fn.name, input.stops ?? 4, docNote);
  const acc = findAccumulators(trace).find((a) => !a.name.startsWith("@"));
  const spec: BuildSpecInput = {
    title: input.title ?? `Dò code: ${call}`,
    subtitle: fn.doc ? truncate(fn.doc.trim().split(/\n/)[0]!.trim(), 110) || `${basename(target.file)}` : basename(target.file),
    trace: rec.tracePath,
    out_dir: outDir,
    viz: chooseViz(trace),
    counters: chooseCounters(trace, fn, acc),
    stops,
  };
  const built = await buildPlayer(spec);
  if (!built.ok || !built.indexPath) return failDrill(`Không tạo được player:\n${built.text}`);
  warnings.push(...built.warnings.filter((w) => !w.startsWith("Player chưa có viz")));
  const questions = built.stops ?? [];
  const lines: string[] = [];
  lines.push(`# Bài dò code sẵn sàng: ${built.indexPath}`);
  lines.push(`- Hàm: ${fn.name} · call: ${call}${derived ? " (lấy từ ví dụ trong docstring)" : ""}`);
  lines.push(`- ${built.steps} bước · ${questions.length} điểm dừng${trace.result !== undefined ? "" : ""}`);
  if (questions.length) {
    lines.push("", "Câu hỏi dự đoán (không kèm đáp án):");
    for (const q of questions) lines.push(`${q.k}. [dòng ${q.line}] ${q.ask}`);
  }
  for (const w of warnings) lines.push(`- Cảnh báo: ${w}`);
  lines.push("", "Slide cho Aurora (Mira không tự ghi vào thư mục deck):", "```json", JSON.stringify(built.auroraSlide, null, 2), "```");
  const res: DrillResult = { ok: true, indexPath: built.indexPath, tracePath: rec.tracePath, outDir, call, stops: questions, warnings, text: lines.join("\n") };
  if (built.auroraSlide) res.auroraSlide = built.auroraSlide;
  return res;
}

function failDrill(text: string): DrillResult {
  return { ok: false, stops: [], warnings: [], text };
}

