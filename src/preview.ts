/**
 * mira_preview: a 127.0.0.1 static server for a player folder, plus POST /__mira/progress which appends contract
 * validated events to <dir>/progress.jsonl. One server per folder.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { appendFile, stat } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { validateProgressEvent } from "./schema.js";
import { notifySmartDrive } from "./smartdrive.js";
import { errMsg } from "./util.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".py": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const MAX_BODY = 64 * 1024;
const DEFAULT_PORT = 4319;
const ALLOWED_TYPES = new Set(["predict", "complete"]);

interface Entry {
  dir: string;
  server: Server;
  port: number;
}

const servers = new Map<string, Entry>();
const keyOf = (dir: string): string => resolve(dir).toLowerCase();

function send(res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

function inside(dir: string, target: string): boolean {
  const a = process.platform === "win32" ? dir.toLowerCase() : dir;
  const b = process.platform === "win32" ? target.toLowerCase() : target;
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

async function handleProgress(entry: Entry, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = req.socket.remoteAddress ?? "";
  if (!(ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) return send(res, 403, "forbidden");
  const ctype = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!ctype.startsWith("application/json")) return send(res, 415, "expected application/json");
  const origin = req.headers.origin;
  if (origin) {
    let own = false;
    try {
      const u = new URL(origin);
      own = (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]") && Number(u.port || 80) === entry.port;
    } catch {
      own = false;
    }
    if (!own) return send(res, 403, "forbidden origin");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      res.end("payload too large");
      req.destroy();
      return;
    }
    chunks.push(buf);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(res, 400, "invalid json");
  }
  const problems = validateProgressEvent(obj);
  if (problems.length === 0 && !ALLOWED_TYPES.has(String((obj as { type: unknown }).type))) {
    problems.push("type: Mira chỉ ghi predict hoặc complete");
  }
  if (problems.length > 0) return send(res, 400, `invalid event: ${problems.join("; ")}`);
  await appendFile(join(entry.dir, "progress.jsonl"), `${JSON.stringify(obj)}\n`, "utf8");
  notifySmartDrive(entry.dir);
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

async function handle(entry: Entry, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    return send(res, 400, "bad request");
  }
  if (pathname.includes("\0")) return send(res, 400, "bad request");
  if (req.method === "POST" && pathname === "/__mira/progress") return handleProgress(entry, req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");

  const target = resolve(entry.dir, pathname.replace(/^[\\/]+/, ""));
  if (!inside(entry.dir, target)) return send(res, 403, "forbidden");
  let file = target;
  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, "index.html");
      info = await stat(file);
    }
  } catch {
    return send(res, 404, "not found");
  }
  if (!info.isFile()) return send(res, 404, "not found");
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Content-Length": info.size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

function listen(entry: Entry, port: number): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer((req, res) => {
      handle(entry, req, res).catch((e) => {
        if (!res.headersSent) send(res, 500, errMsg(e));
        else res.end();
      });
    });
    s.once("error", fail);
    s.listen(port, "127.0.0.1", () => {
      entry.server = s;
      const a = s.address();
      entry.port = typeof a === "object" && a ? a.port : port;
      ok(entry.port);
    });
  });
}

export interface PreviewInfo {
  url: string;
  port: number;
  dir: string;
  reused: boolean;
}

export async function startPreview(dirArg: string, port?: number): Promise<PreviewInfo> {
  const dir = resolve(dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Thư mục không tồn tại: ${dir}`);
  const existing = servers.get(keyOf(dir));
  const page = existsSync(join(dir, "index.html")) ? "index.html" : "";
  if (existing) return { url: `http://127.0.0.1:${existing.port}/${page}`, port: existing.port, dir, reused: true };
  const entry: Entry = { dir, server: undefined as unknown as Server, port: 0 };
  const want = port ?? DEFAULT_PORT;
  let bound = false;
  const tries = port === undefined ? [...Array.from({ length: 12 }, (_, i) => want + i), 0] : [want, ...Array.from({ length: 12 }, (_, i) => want + i + 1), 0];
  for (const p of tries) {
    try {
      await listen(entry, p);
      bound = true;
      break;
    } catch {
      /* busy, try the next one */
    }
  }
  if (!bound) throw new Error("Không mở được máy chủ xem trước (hết cổng trống).");
  servers.set(keyOf(dir), entry);
  return { url: `http://127.0.0.1:${entry.port}/${page}`, port: entry.port, dir, reused: false };
}

export function stopPreview(dirArg: string): boolean {
  const k = keyOf(dirArg);
  const entry = servers.get(k);
  if (!entry) return false;
  entry.server.close();
  entry.server.closeAllConnections?.();
  servers.delete(k);
  return true;
}

export function stopAllPreviews(): number {
  let n = 0;
  for (const dir of [...servers.keys()]) {
    const entry = servers.get(dir);
    if (entry) {
      entry.server.close();
      entry.server.closeAllConnections?.();
      n++;
    }
    servers.delete(dir);
  }
  return n;
}

export function activePreviews(): Array<{ dir: string; port: number }> {
  return [...servers.values()].map((e) => ({ dir: e.dir, port: e.port }));
}
