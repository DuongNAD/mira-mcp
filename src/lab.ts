/**
 * Orion lab integration: `lab` points at an Orion lab folder (lab.json with entry, title, subject, module).
 * Mira traces the learner's own entry file; it never edits the lab.
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface LabRef {
  /** absolute lab folder */
  dir: string;
  /** absolute path of the entry file */
  entryPath: string;
  title: string;
  subject?: string;
  module?: string;
}

export async function readLab(labDir: string): Promise<LabRef> {
  const dir = resolve(labDir);
  const labJson = join(dir, "lab.json");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Thư mục lab không tồn tại: ${dir}`);
  }
  if (!existsSync(labJson)) {
    throw new Error(`Không tìm thấy lab.json trong ${dir}. Đây có phải là thư mục bài lab của Orion không?`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse((await readFile(labJson, "utf8")).replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`lab.json không phải JSON hợp lệ (${labJson}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`lab.json phải là một object (${labJson}).`);
  }
  const o = raw as Record<string, unknown>;
  const entry = typeof o.entry === "string" ? o.entry.trim() : "";
  if (!entry) throw new Error(`lab.json thiếu trường entry (${labJson}).`);
  const entryPath = isAbsolute(entry) ? entry : join(dir, entry);
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    throw new Error(`Tệp entry của lab không tồn tại: ${entryPath}`);
  }
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : entry;
  const out: LabRef = { dir, entryPath, title };
  if (typeof o.subject === "string" && o.subject.trim()) out.subject = o.subject.trim();
  if (typeof o.module === "string" && o.module.trim()) out.module = o.module.trim();
  return out;
}

/** Course and lesson labels for progress events: subject -> course, module (or title) -> lesson. */
export function labLabels(lab: { title?: string; subject?: string; module?: string } | undefined): {
  course?: string;
  lesson?: string;
} {
  if (!lab) return {};
  const out: { course?: string; lesson?: string } = {};
  if (lab.subject) out.course = lab.subject;
  const lesson = lab.module ?? lab.title;
  if (lesson) out.lesson = lesson;
  return out;
}
