/**
 * Progress events emitted by the player (aurora-progress-event.v1). Pure builders plus a small ring buffer that
 * works on any Storage-like object, so Node tests can exercise them with a fake.
 */
import type { PlayerMeta, StopCfg } from "./types.js";

export const SKIPPED_TEXT = "(bỏ qua)";

export interface PredictEvent {
  v: 1;
  t: string;
  course?: string;
  lesson?: string;
  deck: string;
  slide: number;
  slideId: string;
  type: "predict";
  title: string;
  prediction: string;
  rating: "right" | "different";
  output: string;
}

export interface CompleteEvent {
  v: 1;
  t: string;
  course?: string;
  lesson?: string;
  deck: string;
  slide: number;
  slideId: string;
  type: "complete";
  slides: number;
  quiz: null;
  predictions: string | null;
}

export type MiraEvent = PredictEvent | CompleteEvent;

const clip = (s: string, n: number): string => {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n).join("") : s;
};

function labels(meta: PlayerMeta): { course?: string; lesson?: string } {
  const out: { course?: string; lesson?: string } = {};
  if (meta.course) out.course = meta.course;
  if (meta.lesson) out.lesson = meta.lesson;
  return out;
}

export function predictEvent(
  meta: PlayerMeta,
  stop: StopCfg,
  r: { t: string; prediction: string; right: boolean; output: string },
): PredictEvent {
  return {
    v: 1,
    t: r.t,
    ...labels(meta),
    deck: meta.title,
    slide: stop.pos,
    slideId: `mira-stop-${stop.k}`,
    type: "predict",
    title: clip(stop.ask, 200),
    prediction: clip(r.prediction, 2000),
    rating: r.right ? "right" : "different",
    output: clip(r.output, 300),
  };
}

export function completeEvent(meta: PlayerMeta, r: { t: string; steps: number; right: number; total: number }): CompleteEvent {
  return {
    v: 1,
    t: r.t,
    ...labels(meta),
    deck: meta.title,
    slide: Math.max(0, r.steps - 1),
    slideId: "mira-complete",
    type: "complete",
    slides: r.steps,
    quiz: null,
    predictions: r.total > 0 ? `${r.right}/${r.total}` : null,
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RING_MAX = 1000;

export function ringKey(slug: string): string {
  return `mira:${slug}:events`;
}

export function readRing(storage: StorageLike | undefined, slug: string): MiraEvent[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(ringKey(slug));
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as MiraEvent[]) : [];
  } catch {
    return [];
  }
}

/** Appends to the ring buffer (max 1000 events, oldest dropped). Returns the new content. */
export function pushRing(storage: StorageLike | undefined, slug: string, ev: MiraEvent): MiraEvent[] {
  const events = readRing(storage, slug);
  events.push(ev);
  const trimmed = events.length > RING_MAX ? events.slice(events.length - RING_MAX) : events;
  try {
    storage?.setItem(ringKey(slug), JSON.stringify(trimmed));
  } catch {
    // storage may be full or blocked: the player keeps working without it
  }
  return trimmed;
}

export function toJsonl(events: MiraEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

export function exportFileName(slug: string): string {
  return `aurora-progress-mira-${slug}.jsonl`;
}
