import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const VERSION = "0.1.0";

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const hash = (s: string, n = 8): string => createHash("sha1").update(s).digest("hex").slice(0, n);

export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Atomic file write via temp file + rename to prevent corruption. */
export async function atomicWriteFile(targetPath: string, content: string | Buffer): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${targetPath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, targetPath);
  } catch (err) {
    try {
      if (existsSync(tempPath)) await unlink(tempPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text.replace(/^﻿/, "")) as T;
  } catch {
    return undefined;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(data, null, 2) + "\n");
}

/** Levenshtein-based closest match for corrective suggestions. */
export function closest(word: string, candidates: string[]): string | undefined {
  const w = word.toLowerCase();
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const a = w;
    const b = c.toLowerCase();
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    const d = row[b.length]!;
    if (d < bestD && d <= Math.max(3, Math.floor(b.length * 0.45))) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** ASCII slug without diacritics and without Windows-illegal characters. */
export function slugify(input: string, max = 60): string {
  const s = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = s.slice(0, max).replace(/-+$/g, "");
  return cut || "mira";
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Truncates to n characters (code points) with an ellipsis. */
export function truncate(s: string, n: number): string {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, Math.max(1, n - 3)).join("")}...` : s;
}

/** Plural-free Vietnamese-friendly number formatting. */
export function fmtInt(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}

export function fileUrl(path: string, hashPart?: string): string {
  const p = path.replace(/\\/g, "/");
  const url = p.startsWith("/") ? `file://${encodeURI(p)}` : `file:///${encodeURI(p)}`;
  return hashPart ? `${url}#${hashPart}` : url;
}
