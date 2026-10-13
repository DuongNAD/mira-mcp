import type { Model } from "../model.js";

/** A visualisation bound to the model: `update` is called after every step. */
export interface VizInstance {
  el: HTMLElement;
  update(m: Model, k: number, animate: boolean): void;
  resize(): void;
  isEmpty?(): boolean;
}

/**
 * User-space size an SVG visualisation lays itself out in. In a wide container this is the legacy box (the drawing is
 * exactly what it always was); in a narrow one (a phone) it is the real size in CSS pixels, so text and nodes keep
 * their size instead of shrinking together with the viewBox. Without layout (a hidden pane, the fake DOM of the
 * tests) it is the legacy box too.
 */
export function svgSpace(el: Element, baseW: number, baseH: number, wideFrom = 520): { w: number; h: number } {
  if (typeof el.getBoundingClientRect !== "function") return { w: baseW, h: baseH };
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0) || r.width >= wideFrom) return { w: baseW, h: baseH };
  return { w: Math.round(Math.max(220, r.width)), h: Math.round(Math.max(150, r.height)) };
}

export function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/** Compact number for labels: integers as is, floats with up to 4 significant digits. */
export function shortNum(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (Number.isInteger(x)) return String(x);
  const s = Number(x.toPrecision(4)).toString();
  return s;
}

export const VIZ_TITLES: Record<string, string> = {
  array: "Mảng",
  grid: "Lưới",
  graph: "Đồ thị",
  statevector: "Trạng thái lượng tử",
  plot: "Biểu đồ",
  table: "Bảng",
  stack: "Ngăn xếp",
  queue: "Hàng đợi",
  heap: "Heap",
};
