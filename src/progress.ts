/**
 * mira_progress: read progress events written by Mira players (preview server or exported files), summarise per
 * player, and export missed stops for Polaris (error log), Vega (card candidates) and Vega's inbox.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { SKIPPED_TEXT } from "./player/events.js";
import type { PlayerData } from "./player/types.js";
import {
  type ErrorLogEntry,
  type InboxLine,
  type ProgressEvent,
  type VegaCardCandidate,
  validateInboxLine,
  validateProgressEvent,
} from "./schema.js";
import { fileUrl, nowIso, slugify, truncate } from "./util.js";

export interface MissedStop {
  stop: number;
  line?: number;
  question: string;
  prediction: string;
  actual: string;
  skipped: boolean;
}

export interface DeckSummary {
  deck: string;
  course?: string;
  lesson?: string;
  slug: string;
  player?: string;
  totalStops?: number;
  answered: number;
  right: number;
  different: number;
  skipped: number;
  accuracy: number | null;
  lastActivity: string;
  completed: boolean;
  missed: MissedStop[];
}

export interface ProgressSummary {
  sources: string[];
  events: number;
  miraEvents: number;
  ignoredLines: number;
  decks: DeckSummary[];
  errorLogEntries: ErrorLogEntry[];
  vegaCards: VegaCardCandidate[];
  /** inbox lines that to_vega would write (same data, contract shape) */
  inboxLines: InboxLine[];
}

interface PlayerInfo {
  path: string;
  data: PlayerData;
}

const DATA_RE = /<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/;

async function readPlayer(path: string): Promise<PlayerInfo | undefined> {
  try {
    if (statSync(path).size > 8 * 1024 * 1024) return undefined;
    const html = await readFile(path, "utf8");
    const m = DATA_RE.exec(html);
    if (!m) return undefined;
    const data = JSON.parse(m[1] as string) as PlayerData;
    if (!data?.meta?.title || !Array.isArray(data.stops)) return undefined;
    return { path, data };
  } catch {
    return undefined;
  }
}

/** Players next to the progress data: <dir>/index.html and <dir>/<child>/index.html (no deeper scan). */
async function findPlayers(dirs: string[]): Promise<PlayerInfo[]> {
  const found: PlayerInfo[] = [];
  const seen = new Set<string>();
  const tryPath = async (p: string): Promise<void> => {
    const abs = resolve(p);
    if (seen.has(abs.toLowerCase()) || !existsSync(abs)) return;
    seen.add(abs.toLowerCase());
    const info = await readPlayer(abs);
    if (info) found.push(info);
  };
  for (const dir of dirs) {
    await tryPath(join(dir, "index.html"));
    let children: string[] = [];
    try {
      children = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .slice(0, 60);
    } catch {
      children = [];
    }
    for (const c of children) await tryPath(join(dir, c, "index.html"));
  }
  return found;
}

function readableDir(path: string): string {
  return statSync(path).isDirectory() ? path : dirname(path);
}

export interface ProgressOptions {
  dir?: string;
  file?: string;
  hub?: string;
}

export function resolveHub(hub?: string): string {
  return resolve(hub ?? process.env.MIRA_HUB ?? process.env.POLARIS_HUB ?? "D:/02_Learning_Knowledge");
}

function subjectFor(playerPath: string | undefined, hub: string, fallback: string | undefined): string {
  if (playerPath) {
    const rel = relative(hub, resolve(playerPath));
    if (rel && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel)) {
      const first = rel.split(sep)[0];
      if (first && first !== "." && first.length <= 120) return first;
    }
  }
  return truncate(fallback ?? "Mira", 120);
}

export async function readProgress(opts: ProgressOptions): Promise<ProgressSummary> {
  const files: string[] = [];
  const dirs: string[] = [];
  if (opts.dir) {
    const dir = resolve(opts.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Thư mục không tồn tại: ${dir}`);
    dirs.push(dir);
    const main = join(dir, "progress.jsonl");
    if (existsSync(main)) files.push(main);
    try {
      for (const name of readdirSync(dir)) {
        if (/^aurora-progress-mira-.*\.jsonl$/i.test(name)) files.push(join(dir, name));
      }
    } catch {
      // ignore unreadable folder
    }
  }
  if (opts.file) {
    const f = resolve(opts.file);
    if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`Không tìm thấy tệp tiến độ: ${f}`);
    files.push(f);
    dirs.push(readableDir(f));
  }
  if (!opts.dir && !opts.file) throw new Error("Cần `dir` (thư mục có progress.jsonl) hoặc `file` (tệp .jsonl đã xuất).");
  if (files.length === 0) {
    throw new Error(`Chưa có tiến độ nào: không thấy progress.jsonl trong ${opts.dir}. Mở player qua mira_preview, hoặc dùng nút "Xuất tiến độ" rồi truyền \`file\`.`);
  }

  const events: ProgressEvent[] = [];
  let ignored = 0;
  for (const f of [...new Set(files)]) {
    const text = await readFile(f, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj: unknown = JSON.parse(line);
        if (validateProgressEvent(obj).length === 0) events.push(obj as ProgressEvent);
        else ignored++;
      } catch {
        ignored++;
      }
    }
  }
  const players = await findPlayers([...new Set(dirs)]);
  const byTitle = new Map<string, PlayerInfo>();
  for (const p of players) if (!byTitle.has(p.data.meta.title)) byTitle.set(p.data.meta.title, p);

  const miraEvents = events.filter((e) => typeof e.slideId === "string" && (/^mira-stop-\d+$/.test(e.slideId) || e.slideId === "mira-complete"));
  const hub = resolveHub(opts.hub);
  const decks = new Map<string, { last: Map<number, ProgressEvent>; complete: boolean; lastT: string; course?: string; lesson?: string }>();
  for (const e of miraEvents) {
    let d = decks.get(e.deck);
    if (!d) {
      d = { last: new Map(), complete: false, lastT: "" };
      decks.set(e.deck, d);
    }
    if (e.t > d.lastT) d.lastT = e.t;
    if (typeof e.course === "string") d.course = e.course;
    if (typeof e.lesson === "string") d.lesson = e.lesson;
    if (e.type === "complete") d.complete = true;
    else if (e.type === "predict") {
      const k = Number(/\d+$/.exec(e.slideId as string)?.[0]);
      const prev = d.last.get(k);
      if (!prev || e.t >= prev.t) d.last.set(k, e);
    }
  }

  const summaries: DeckSummary[] = [];
  const errorLogEntries: ErrorLogEntry[] = [];
  const vegaCards: VegaCardCandidate[] = [];
  const inboxLines: InboxLine[] = [];
  const stamp = nowIso();
  for (const [deck, d] of decks) {
    const player = byTitle.get(deck);
    const slug = player?.data.meta.slug ?? slugify(deck, 48);
    let right = 0;
    let different = 0;
    let skipped = 0;
    const missed: MissedStop[] = [];
    for (const [k, e] of [...d.last.entries()].sort((a, b) => a[0] - b[0])) {
      const isSkip = e.prediction === SKIPPED_TEXT;
      if (e.rating === "right") right++;
      else if (isSkip) skipped++;
      else different++;
      if (e.rating !== "right") {
        const stop = player?.data.stops.find((s) => s.k === k);
        const m: MissedStop = {
          stop: k,
          question: String(e.title ?? ""),
          prediction: String(e.prediction ?? ""),
          actual: String(e.output ?? ""),
          skipped: isSkip,
        };
        if (stop) m.line = stop.line;
        missed.push(m);
      }
    }
    const answered = right + different;
    const summary: DeckSummary = {
      deck,
      slug,
      answered,
      right,
      different,
      skipped,
      accuracy: answered > 0 ? right / answered : null,
      lastActivity: d.lastT,
      completed: d.complete,
      missed,
    };
    const course = d.course ?? player?.data.meta.course;
    const lesson = d.lesson ?? player?.data.meta.lesson;
    if (course) summary.course = course;
    if (lesson) summary.lesson = lesson;
    if (player) {
      summary.player = player.path;
      summary.totalStops = player.data.stops.length;
    }
    summaries.push(summary);

    const originPath = player?.path ?? [...new Set(files)][0] ?? deck;
    const call = player?.data.meta.call ?? player?.data.meta.file;
    for (const m of missed) {
      const e = d.last.get(m.stop) as ProgressEvent;
      const stop = player?.data.stops.find((s) => s.k === m.stop);
      const codeLine = stop && player ? (player.data.source[stop.line - 1] ?? "").trim() : "";
      const fixLine = m.line ? `Dò lại dòng ${m.line} và ghi quy tắc rút ra` : "Dò lại dòng liên quan và ghi quy tắc rút ra";
      if (!m.skipped) {
        const entry: ErrorLogEntry = {
          date: e.t.slice(0, 10),
          prediction: m.prediction,
          result: m.actual,
          why: `Dự đoán sai khi dò code: ${m.question}`,
          fix: fixLine,
          source: `${originPath} stop ${m.stop}`,
        };
        if (lesson) entry.lesson = lesson;
        errorLogEntries.push(entry);
        const front = `Dò code${call ? ` \`${truncate(call, 80)}\`` : ""}${stop ? `, dòng ${stop.line}${codeLine ? ` \`${truncate(codeLine, 70)}\`` : ""}` : ""}: ${m.question}`;
        const explain = stop?.explain ? ` ${stop.explain}` : "";
        const card: VegaCardCandidate = {
          deck,
          kind: "basic",
          front: truncate(front, 600),
          back: truncate(`Giá trị thật: \`${m.actual}\`.${explain}`, 1200),
          origin: { kind: "manual", path: originPath, locator: `stop ${m.stop}` },
          tags: ["mira"],
        };
        if (course) card.subject = course;
        vegaCards.push(card);
      }
      // inbox: wrong predictions and skipped stops both come back for review
      const front = `Dò${call ? ` \`${truncate(call, 80)}\`` : " code"}: ${m.question}`;
      const explain = stop?.explain ? ` ${stop.explain}` : "";
      const line: InboxLine = {
        v: 1,
        t: stamp,
        producer: "mira",
        key: `mira:${slug}:stop-${m.stop}`,
        subject: subjectFor(player?.path, hub, course),
        deck: truncate(deck, 120),
        kind: "basic",
        front: truncate(front, 600),
        back: truncate(`Giá trị thật: \`${m.actual}\`.${explain}`, 1200),
        origin: {
          kind: "mira-stop",
          path: truncate(originPath, 400),
          locator: `stop ${m.stop}`,
          ...(player ? { href: truncate(fileUrl(player.path, `stop-${m.stop}`), 400) } : {}),
        },
        tags: ["mira"],
        reason: m.skipped ? `Bỏ qua điểm dừng ${m.stop}` : `Dự đoán sai ở điểm dừng ${m.stop}`,
      };
      inboxLines.push(line);
    }
  }
  summaries.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  return {
    sources: [...new Set(files)],
    events: events.length,
    miraEvents: miraEvents.length,
    ignoredLines: ignored,
    decks: summaries,
    errorLogEntries,
    vegaCards,
    inboxLines,
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `<producer>-<YYYYMMDDTHHmmss>-<6 hex>.jsonl` (UTC). */
export function inboxFileName(now = new Date()): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `mira-${stamp}-${randomBytes(3).toString("hex")}.jsonl`;
}

export interface InboxWrite {
  path: string;
  lines: number;
  keys: string[];
}

/** Writes ONE inbox file per call into <hub>/.vega/inbox/ (validated, .tmp then rename). */
export async function writeVegaInbox(lines: InboxLine[], hubArg?: string): Promise<InboxWrite | undefined> {
  if (lines.length === 0) return undefined;
  for (const l of lines) {
    const problems = validateInboxLine(l);
    if (problems.length) throw new Error(`Dòng inbox không đúng hợp đồng vega-card-inbox.v1 (${l.key}): ${problems.join("; ")}`);
  }
  const hub = resolveHub(hubArg);
  const folder = join(hub, ".vega", "inbox");
  await mkdir(folder, { recursive: true });
  const name = inboxFileName();
  const finalPath = join(folder, name);
  const tmp = `${finalPath}.tmp`;
  await writeFile(tmp, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
  await rename(tmp, finalPath);
  return { path: finalPath, lines: lines.length, keys: lines.map((l) => l.key) };
}

export function formatProgress(s: ProgressSummary, inbox?: InboxWrite | { skipped: string }): string {
  const out: string[] = [];
  out.push(`# Tiến độ dò code (${s.miraEvents} sự kiện Mira từ ${s.sources.length} tệp)`);
  if (s.decks.length === 0) out.push("Chưa có sự kiện nào của Mira trong nguồn này.");
  for (const d of s.decks) {
    const acc = d.accuracy === null ? "chưa trả lời" : `${Math.round(d.accuracy * 100)}% đúng`;
    out.push("", `## ${d.deck}${d.completed ? " (đã đi hết)" : ""}`);
    out.push(`- Đã trả lời ${d.answered}${d.totalStops ? `/${d.totalStops}` : ""}: đúng ${d.right}, khác dự đoán ${d.different}, bỏ qua ${d.skipped} · ${acc}`);
    out.push(`- Hoạt động gần nhất: ${d.lastActivity}`);
    if (d.player) out.push(`- Player: ${d.player}`);
    if (d.missed.length) {
      out.push("- Điểm dừng chưa đúng:");
      for (const m of d.missed) {
        out.push(`  - điểm ${m.stop}${m.line ? ` (dòng ${m.line})` : ""}: ${m.question}`);
        out.push(`    dự đoán: ${m.skipped ? "(bỏ qua)" : m.prediction || "(trống)"} · thực tế: ${m.actual}`);
      }
    }
  }
  if (s.ignoredLines) out.push("", `Bỏ qua ${s.ignoredLines} dòng không hợp lệ.`);
  out.push("", "JSON cho polaris_errorlog_add và vega_add (chép từng phần tử):", "```json");
  out.push(JSON.stringify({ errorLogEntries: s.errorLogEntries, vegaCards: s.vegaCards }, null, 2));
  out.push("```");
  if (inbox) {
    if ("skipped" in inbox) out.push("", inbox.skipped);
    else out.push("", `Đã ghi ${inbox.lines} thẻ vào hộp thư Vega: ${inbox.path}`, "Vega sẽ nạp ở lần vega_sync tiếp theo và bỏ qua thẻ trùng khoá.");
  }
  return out.join("\n");
}

