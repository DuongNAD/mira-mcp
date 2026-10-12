import type { Model } from "../model.js";
import type { GridCfg, Val } from "../types.js";
import { h, isReducedMotion, setText } from "../ui/dom.js";
import { cellOf, entriesOf, isDictVal, itemsOf, ndToVal, numOf, pairOf } from "../values.js";
import { type VizInstance, cssVar } from "./common.js";

const EMPTY = 0;
const WALL = 1;
const VISITED = 2;
const FRONTIER = 3;
const PATH = 4;
const ANIM_MS = 260;

/** Set of cell indexes from a list/set of (r, c) pairs (or heap entries ending in a pair) or dict keys. */
function cellIndexes(v: Val | undefined, rows: number, cols: number): number[] {
  if (v === undefined) return [];
  const out: number[] = [];
  const push = (cell: [number, number] | undefined): void => {
    if (!cell) return;
    const [r, c] = cell;
    if (Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < rows && c < cols) out.push(r * cols + c);
  };
  if (isDictVal(v)) {
    for (const [key] of entriesOf(v) ?? []) push(cellOf(key));
    return out;
  }
  for (const item of itemsOf(v) ?? []) push(cellOf(item));
  return out;
}

function isWallValue(x: Val | undefined): boolean {
  if (x === true) return true;
  if (typeof x === "string") return x === "#" || x === "X" || x === "x" || x === "1";
  const n = numOf(x);
  return n !== undefined && n !== 0;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number): void {
  const rad = Math.min(r, w / 2, hh / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + hh, rad);
  ctx.arcTo(x + w, y + hh, x, y + hh, rad);
  ctx.arcTo(x, y + hh, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function createGrid(cfg: GridCfg): VizInstance {
  const canvas = h("canvas", { class: "grid-canvas" });
  const wrap = h("div", { class: "grid-wrap" }, canvas);
  const note = h("div", { class: "viz-empty" });
  const legend = h("div", { class: "legend" });
  const el = h("div", { class: "viz-grid" }, wrap, legend);
  el.appendChild(note);
  note.style.display = "none";

  const legendItems: Array<[string, string]> = [];
  if (cfg.var || cfg.walls) legendItems.push(["wall", "Tường"]);
  if (cfg.visited) legendItems.push(["visited", "Đã xét"]);
  if (cfg.frontier) legendItems.push(["frontier", "Hàng đợi"]);
  if (cfg.path) legendItems.push(["path", "Đường đi"]);
  if (cfg.current) legendItems.push(["current", "Ô hiện tại"]);
  if (cfg.start) legendItems.push(["start", "Bắt đầu"]);
  if (cfg.goal) legendItems.push(["goal", "Đích"]);
  for (const [cls, label] of legendItems) {
    legend.appendChild(h("span", { class: "lg-item" }, h("i", { class: `lg-dot lg-${cls}` }), label));
  }

  let rows = 0;
  let cols = 0;
  let kinds = new Uint8Array(0);
  let prevKinds = new Uint8Array(0);
  let born = new Float64Array(0);
  let current = -1;
  let start = -1;
  let goal = -1;
  let animUntil = 0;
  let raf = 0;
  const reduced = isReducedMotion();

  const draw = (now: number): void => {
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    if (!cssW || !cssH || !rows || !cols) return;
    const dpr = Math.min(3, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const pad = 4;
    const cell = Math.max(2, Math.floor(Math.min((cssW - pad * 2) / cols, (cssH - pad * 2) / rows)));
    const gap = cell >= 12 ? 1.5 : cell >= 6 ? 1 : 0;
    const ox = Math.round((cssW - cell * cols) / 2);
    const oy = Math.round((cssH - cell * rows) / 2);
    const colEmpty = cssVar("--cell", "#1d2229");
    const colWall = cssVar("--wall", "#3a414c");
    const colBlue = cssVar("--blue", "#5AA9E6");
    const colAccent = cssVar("--accent", "#E8A23B");
    const colGreen = cssVar("--green", "#4CC38A");
    const colRed = cssVar("--red", "#E5484D");
    const radius = Math.max(1, cell * 0.2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const x = ox + c * cell + gap / 2;
        const y = oy + r * cell + gap / 2;
        const w = cell - gap;
        const kind = kinds[i] as number;
        const t = animUntil > now ? Math.min(1, Math.max(0, (now - (born[i] as number)) / ANIM_MS)) : 1;
        ctx.globalAlpha = 1;
        ctx.fillStyle = colEmpty;
        roundedRect(ctx, x, y, w, w, radius);
        ctx.fill();
        if (kind === EMPTY) continue;
        ctx.fillStyle = kind === WALL ? colWall : kind === VISITED ? colBlue : kind === FRONTIER ? colAccent : colGreen;
        ctx.globalAlpha = (kind === WALL ? 1 : kind === VISITED ? 0.42 : kind === FRONTIER ? 0.62 : 0.92) * t;
        roundedRect(ctx, x, y, w, w, radius);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const ring = (idx: number, color: string, filled: boolean): void => {
      if (idx < 0) return;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const x = ox + c * cell + gap / 2;
      const y = oy + r * cell + gap / 2;
      const w = cell - gap;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(1.5, cell * 0.12);
      if (filled) {
        roundedRect(ctx, x, y, w, w, radius);
        ctx.fill();
      } else {
        roundedRect(ctx, x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, w - ctx.lineWidth, w - ctx.lineWidth, radius);
        ctx.stroke();
      }
    };
    ring(start, colGreen, false);
    ring(goal, colRed, false);
    if (current >= 0) {
      ring(current, colAccent, true);
      const r = Math.floor(current / cols);
      const c = current % cols;
      ctx.strokeStyle = cssVar("--text", "#E6E8EB");
      ctx.lineWidth = 1.5;
      roundedRect(ctx, ox + c * cell + 0.5, oy + r * cell + 0.5, cell - 1, cell - 1, radius + 1);
      ctx.stroke();
    }
  };

  const tick = (): void => {
    raf = 0;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    draw(now);
    if (now < animUntil && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);
  };

  const redraw = (animate: boolean): void => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (animate && !reduced) {
      animUntil = now + ANIM_MS + 30;
      if (!raf && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);
      else if (!raf) draw(now);
    } else {
      animUntil = 0;
      draw(now);
    }
  };

  const update = (m: Model, k: number, animate: boolean): void => {
    let nr = cfg.rows ?? 0;
    let nc = cfg.cols ?? 0;
    let gridV: Val | undefined;
    let gridRows: Val[] | undefined;
    if (cfg.var) {
      gridV = m.get(k, cfg.var);
      gridRows = itemsOf(ndToVal(gridV) ?? gridV);
      if (gridRows) {
        nr = gridRows.length;
        nc = Math.max(0, ...gridRows.map((r) => itemsOf(r)?.length ?? 0));
      }
    }
    if (!nr || !nc) {
      canvas.style.display = "none";
      note.style.display = "";
      setText(note, cfg.var ? `Chưa có lưới trong ${cfg.var}` : "Chưa có kích thước lưới");
      return;
    }
    canvas.style.display = "";
    note.style.display = "none";
    const sizeChanged = nr !== rows || nc !== cols;
    rows = nr;
    cols = nc;
    const next = new Uint8Array(rows * cols);

    // walls: explicit expression wins, otherwise truthy cells of the grid variable
    if (cfg.walls) {
      const wv = m.evalAt(k, cfg.walls);
      const wrows = itemsOf(wv);
      if (wrows && wrows.length > 0 && wrows.every((r) => Array.isArray(r) || itemsOf(r) !== undefined) && itemsOf(wrows[0])?.length !== 2) {
        wrows.forEach((row, r) => (itemsOf(row) ?? []).forEach((x, c) => {
          if (r < rows && c < cols && isWallValue(x)) next[r * cols + c] = WALL;
        }));
      } else {
        for (const i of cellIndexes(wv, rows, cols)) next[i] = WALL;
      }
    } else if (gridRows) {
      gridRows.forEach((row, r) => (itemsOf(row) ?? []).forEach((x, c) => {
        if (isWallValue(x)) next[r * cols + c] = WALL;
      }));
    }
    const mark = (src: string | undefined, kind: number, override: boolean): void => {
      if (!src) return;
      for (const i of cellIndexes(m.evalAt(k, src), rows, cols)) {
        if (next[i] === WALL) continue;
        if (override || next[i] === EMPTY) next[i] = kind;
      }
    };
    mark(cfg.frontier, FRONTIER, false);
    mark(cfg.visited, VISITED, true);
    mark(cfg.path, PATH, true);

    const pt = (src: [number, number] | string | undefined): number => {
      if (src === undefined) return -1;
      const p = typeof src === "string" ? (m.evalAt(k, src) === undefined ? undefined : cellOf(m.evalAt(k, src))) : src;
      if (!p) return -1;
      return p[0] >= 0 && p[1] >= 0 && p[0] < rows && p[1] < cols ? p[0] * cols + p[1] : -1;
    };
    current = -1;
    if (cfg.current) {
      const v = m.evalAt(k, cfg.current);
      const p = v === undefined ? undefined : (cellOf(v) ?? pairOf(v));
      if (p && p[0] >= 0 && p[1] >= 0 && p[0] < rows && p[1] < cols) current = p[0] * cols + p[1];
    }
    start = pt(cfg.start);
    goal = pt(cfg.goal);

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (sizeChanged || prevKinds.length !== next.length) {
      born = new Float64Array(next.length);
      prevKinds = new Uint8Array(next.length);
    }
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== prevKinds[i]) born[i] = now;
    }
    kinds = next;
    prevKinds = next;
    redraw(animate);
  };

  return { el, update, resize: () => redraw(false) };
}
