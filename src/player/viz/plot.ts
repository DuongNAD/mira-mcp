import type { Model } from "../model.js";
import type { PlotCfg } from "../types.js";
import { h, s, setText } from "../ui/dom.js";
import { numOf } from "../values.js";
import { arrayItems } from "./array.js";
import { type VizInstance, shortNum, svgSpace } from "./common.js";

/** Legacy drawing box; a narrow container (a phone) is laid out in its real pixels instead, see svgSpace. */
const BASE_W = 600;
const BASE_H = 320;
const PAD = { l: 52, r: 18, t: 16, b: 30 };

export function createPlot(cfg: PlotCfg): VizInstance {
  let W = BASE_W;
  let H = BASE_H;
  const svg = s("svg", { class: "plot-svg", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", role: "img" });
  const note = h("div", { class: "viz-empty" });
  const el = h("div", { class: "viz-plot" }, svg, note);
  note.style.display = "none";
  let last: { m: Model; k: number } | undefined;
  /** Re-reads the container size; true when the drawing space changed. */
  const fit = (): boolean => {
    const sp = svgSpace(svg, BASE_W, BASE_H);
    if (sp.w === W && sp.h === H) return false;
    W = sp.w;
    H = sp.h;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    return true;
  };

  const update = (m: Model, k: number, _animate?: boolean): void => {
    last = { m, k };
    svg.style.display = ""; // it must be laid out to be measured
    fit();
    const v = m.get(k, cfg.var);
    const items = arrayItems(v);
    const ys = items?.map((x) => numOf(x)).filter((x): x is number => x !== undefined && Number.isFinite(x)) ?? [];
    if (!items || ys.length === 0) {
      svg.style.display = "none";
      note.style.display = "";
      setText(note, v === undefined ? `Chưa có giá trị cho ${cfg.var}` : `${cfg.var} chưa có số nào để vẽ`);
      return;
    }
    note.style.display = "none";
    svg.textContent = "";
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    if (hi - lo < 1e-12) {
      lo -= 1;
      hi += 1;
    } else {
      const margin = (hi - lo) * 0.08;
      lo -= margin;
      hi += margin;
    }
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const X = (i: number): number => PAD.l + (ys.length === 1 ? iw / 2 : (i / (ys.length - 1)) * iw);
    const Y = (y: number): number => PAD.t + ih - ((y - lo) / (hi - lo)) * ih;

    for (let g = 0; g <= 3; g++) {
      const gy = PAD.t + (ih * g) / 3;
      const val = hi - ((hi - lo) * g) / 3;
      svg.appendChild(s("line", { class: "pgrid", x1: PAD.l, x2: W - PAD.r, y1: gy.toFixed(1), y2: gy.toFixed(1) }));
      svg.appendChild(s("text", { class: "ptick", x: PAD.l - 8, y: (gy + 4).toFixed(1), "text-anchor": "end", text: shortNum(Number(val.toPrecision(3))) }));
    }
    svg.appendChild(s("line", { class: "paxis", x1: PAD.l, x2: PAD.l, y1: PAD.t, y2: PAD.t + ih }));
    svg.appendChild(s("line", { class: "paxis", x1: PAD.l, x2: W - PAD.r, y1: PAD.t + ih, y2: PAD.t + ih }));
    svg.appendChild(s("text", { class: "ptick", x: PAD.l, y: H - 10, "text-anchor": "start", text: "0" }));
    svg.appendChild(s("text", { class: "ptick", x: W - PAD.r, y: H - 10, "text-anchor": "end", text: String(ys.length - 1) }));
    if (cfg.y_label) {
      svg.appendChild(s("text", { class: "plabel", x: PAD.l + 6, y: PAD.t - 3, "text-anchor": "start", text: cfg.y_label }));
    }
    const pts = ys.map((y, i) => `${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join(" ");
    if (ys.length > 1) svg.appendChild(s("polyline", { class: "pline", points: pts }));
    const lastI = ys.length - 1;
    svg.appendChild(s("circle", { class: "pdot", cx: X(lastI).toFixed(1), cy: Y(ys[lastI] as number).toFixed(1), r: 4.5 }));
    svg.appendChild(
      s("text", { class: "pvalue", x: X(lastI).toFixed(1), y: (Y(ys[lastI] as number) - 10).toFixed(1), "text-anchor": lastI > ys.length * 0.8 ? "end" : "middle", text: shortNum(ys[lastI] as number) }),
    );
  };

  let lastEmpty = true;
  return {
    el,
    update: (...args) => {
      update(...args);
      lastEmpty = note.style.display !== "none";
    },
    resize: () => {
      if (fit() && last) update(last.m, last.k);
    },
    isEmpty: () => lastEmpty,
  };
}
