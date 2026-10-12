import type { Model } from "../model.js";
import type { StatevectorCfg } from "../types.js";
import { h, icon, s, setText } from "../ui/dom.js";
import { complexListOf, fmtComplex } from "../values.js";
import { type VizInstance, shortNum } from "./common.js";

const MAX_ROWS = 64;

export function createStatevector(cfg: StatevectorCfg): VizInstance {
  const head = h("div", { class: "sv-head" });
  const toggle = h(
    "button",
    { class: "chip", type: "button", title: "Chuyển giữa biểu đồ và bảng biên độ" },
    icon("table", 14),
    h("span", { text: "Bảng biên độ" }),
  );
  const rowsEl = h("div", { class: "sv-rows" });
  const tableWrap = h("div", { class: "tbl-wrap sv-table" });
  const note = h("div", { class: "viz-empty" });
  const el = h("div", { class: "viz-sv" }, head, rowsEl, tableWrap, note);
  head.appendChild(toggle);
  const info = h("span", { class: "sv-info" });
  head.insertBefore(info, toggle);
  let showTable = false;
  let last: { m: Model; k: number } | undefined;

  toggle.addEventListener("click", () => {
    showTable = !showTable;
    if (last) update(last.m, last.k);
  });

  function dial(re: number, im: number, mag: number): SVGSVGElement {
    const svg = s("svg", { class: "sv-dial", viewBox: "-12 -12 24 24", width: 22, height: 22, "aria-hidden": "true" });
    svg.appendChild(s("circle", { r: 10, class: "dial-ring" }));
    if (mag > 1e-9) {
      const ang = Math.atan2(im, re);
      const hue = Math.round(((ang + Math.PI) / (2 * Math.PI)) * 360);
      const x = 9 * Math.cos(ang);
      const y = -9 * Math.sin(ang);
      svg.appendChild(s("line", { x1: 0, y1: 0, x2: x.toFixed(2), y2: y.toFixed(2), class: "dial-hand", style: { stroke: `hsl(${hue} 42% 62%)` } }));
    }
    return svg;
  }

  function update(m: Model, k: number): void {
    last = { m, k };
    const amps = complexListOf(m.get(k, cfg.var));
    if (!amps || amps.length === 0) {
      rowsEl.style.display = "none";
      tableWrap.style.display = "none";
      note.style.display = "";
      setText(note, `Chưa có vector trạng thái trong ${cfg.var}`);
      return;
    }
    note.style.display = "none";
    const n = amps.length;
    const qubits = Math.log2(n);
    const isPow2 = Number.isInteger(qubits);
    const probs = amps.map(([re, im]) => re * re + im * im);
    const total = probs.reduce((a, b) => a + b, 0);
    setText(info, `${isPow2 ? `${qubits} qubit · ` : ""}tổng xác suất ${total.toFixed(3)}`);
    setText(toggle.querySelector("span") as HTMLElement, showTable ? "Biểu đồ" : "Bảng biên độ");
    const label = (i: number): string => `|${isPow2 ? i.toString(2).padStart(qubits, "0") : i}>`;
    const order = amps.map((_, i) => i);
    const shown = n > MAX_ROWS ? order.sort((a, b) => (probs[b] as number) - (probs[a] as number)).slice(0, MAX_ROWS).sort((a, b) => a - b) : order;

    if (showTable) {
      rowsEl.style.display = "none";
      tableWrap.style.display = "";
      tableWrap.textContent = "";
      const table = h("table", { class: "tbl" }, h("thead", null, h("tr", null, h("th", { text: "Trạng thái" }), h("th", { text: "Biên độ" }), h("th", { text: "Xác suất" }))));
      const body = h("tbody");
      for (const i of shown) {
        const [re, im] = amps[i] as [number, number];
        body.appendChild(
          h("tr", null, h("td", { class: "mono", text: label(i) }), h("td", { class: "mono", text: fmtComplex(Number(re.toFixed(4)), Number(im.toFixed(4))) }), h("td", { class: "mono", text: `${((probs[i] as number) * 100).toFixed(1)}%` })),
        );
      }
      table.appendChild(body);
      tableWrap.appendChild(table);
      return;
    }
    tableWrap.style.display = "none";
    rowsEl.style.display = "";
    rowsEl.textContent = "";
    rowsEl.className = `sv-rows${shown.length > 24 ? " dense" : ""}`;
    for (const i of shown) {
      const [re, im] = amps[i] as [number, number];
      const p = probs[i] as number;
      const pct = p > 0 ? Math.max(0.8, p * 100) : 0;
      const fill = h("i");
      fill.style.width = `${Math.min(100, pct)}%`;
      rowsEl.appendChild(
        h(
          "div",
          { class: `sv-row${p > 1e-9 ? "" : " zero"}` },
          h("span", { class: "sv-lab mono", text: label(i) }),
          h("span", { class: "sv-track" }, fill),
          h("span", { class: "sv-pct mono", text: `${shortNum(Number((p * 100).toFixed(1)))}%` }),
          dial(re, im, Math.sqrt(p)),
        ),
      );
    }
    if (n > MAX_ROWS) rowsEl.appendChild(h("div", { class: "sv-more", text: `Hiện ${MAX_ROWS} trạng thái có xác suất lớn nhất trong ${n}` }));
  }

  return { el, update, resize: () => undefined };
}
