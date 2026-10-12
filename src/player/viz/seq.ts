import type { Model } from "../model.js";
import type { SeqCfg, Val } from "../types.js";
import { h, s, setText } from "../ui/dom.js";
import { numOf, pyRepr } from "../values.js";
import { arrayItems } from "./array.js";
import { type VizInstance, shortNum, svgSpace } from "./common.js";

/** Legacy tree width; a narrow container (a phone) is laid out in its real pixels instead, see svgSpace. */
const BASE_W = 600;
const MAX_TREE = 31;

function boxText(x: Val, max = 18): string {
  const n = numOf(x);
  if (n !== undefined && typeof x !== "boolean") return shortNum(n);
  return pyRepr(x, max, 4);
}

export function createSeq(cfg: SeqCfg): VizInstance {
  const body = h("div", { class: `seq seq-${cfg.kind}` });
  const note = h("div", { class: "viz-empty" });
  const el = h("div", { class: "viz-seq" }, body, note);
  note.style.display = "none";

  const tree = (items: Val[]): SVGSVGElement => {
    const n = Math.min(items.length, MAX_TREE);
    const levels = Math.ceil(Math.log2(n + 1));
    const H = Math.max(80, levels * 62 + 20);
    const W = svgSpace(body, BASE_W, 100).w;
    // legacy radius 17; in a narrow container never more than 45% of the gap between neighbours on the bottom level
    const r = W === BASE_W ? 17 : Math.max(7, Math.min(17, Math.floor(((W - 20) / 2 ** (levels - 1)) * 0.45)));
    const fontPx = Math.min(11, Math.round(r * 0.68 * 10) / 10);
    const svg = s("svg", { class: "heap-tree", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMin meet", role: "img" });
    const pos = (i: number): [number, number] => {
      const level = Math.floor(Math.log2(i + 1));
      const first = 2 ** level - 1;
      const idx = i - first;
      const count = 2 ** level;
      return [((idx + 0.5) / count) * (W - 20) + 10, level * 62 + 28];
    };
    for (let i = 1; i < n; i++) {
      const [x1, y1] = pos(Math.floor((i - 1) / 2));
      const [x2, y2] = pos(i);
      svg.appendChild(s("line", { class: "hedge", x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1) }));
    }
    for (let i = 0; i < n; i++) {
      const [x, y] = pos(i);
      const g = s("g", { class: `hnode${i === 0 ? " root" : ""}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` });
      g.appendChild(s("circle", { r }));
      g.appendChild(s("text", { "text-anchor": "middle", dy: "0.35em", text: boxText(items[i] as Val, 6), style: fontPx < 11 ? { "font-size": `${fontPx}px` } : undefined }));
      svg.appendChild(g);
    }
    return svg;
  };

  let last: { m: Model; k: number } | undefined;
  let lastWidth = 0;
  const bodyWidth = (): number => (typeof body.getBoundingClientRect === "function" ? Math.round(body.getBoundingClientRect().width) : 0);

  const update = (m: Model, k: number): void => {
    last = { m, k };
    const v = m.get(k, cfg.var);
    const items = arrayItems(v);
    if (!items) {
      body.style.display = "none";
      note.style.display = "";
      setText(note, v === undefined ? `Chưa có giá trị cho ${cfg.var}` : `${cfg.var} không phải danh sách`);
      return;
    }
    body.style.display = "";
    note.style.display = "none";
    body.textContent = "";
    if (items.length === 0) {
      body.appendChild(h("div", { class: "seq-empty", text: cfg.kind === "stack" ? "Ngăn xếp rỗng" : cfg.kind === "queue" ? "Hàng đợi rỗng" : "Heap rỗng" }));
      return;
    }
    if (cfg.kind === "stack") {
      const col = h("div", { class: "stack-col" });
      for (let i = items.length - 1; i >= 0; i--) {
        const top = i === items.length - 1;
        col.appendChild(h("div", { class: `sbox${top ? " top" : ""}` }, h("span", { class: "sbox-v", text: boxText(items[i] as Val) }), top ? h("span", { class: "sbox-tag", text: "đỉnh" }) : null));
      }
      body.appendChild(col);
      return;
    }
    if (cfg.kind === "queue") {
      const row = h("div", { class: "queue-row" });
      items.forEach((x, i) => {
        row.appendChild(
          h(
            "div",
            { class: `sbox${i === 0 ? " top" : ""}` },
            h("span", { class: "sbox-v", text: boxText(x) }),
            i === 0 ? h("span", { class: "sbox-tag", text: "đầu" }) : i === items.length - 1 ? h("span", { class: "sbox-tag", text: "cuối" }) : null,
          ),
        );
      });
      body.appendChild(row);
      return;
    }
    // heap: array order plus a binary tree
    const row = h("div", { class: "queue-row heap-row" });
    items.slice(0, 40).forEach((x, i) => {
      row.appendChild(h("div", { class: `sbox${i === 0 ? " top" : ""}` }, h("span", { class: "sbox-i", text: String(i) }), h("span", { class: "sbox-v", text: boxText(x) })));
    });
    body.appendChild(row);
    lastWidth = bodyWidth();
    body.appendChild(tree(items));
    if (items.length > MAX_TREE) body.appendChild(h("div", { class: "sv-more", text: `Cây chỉ vẽ ${MAX_TREE} nút đầu trong ${items.length}` }));
  };

  return {
    el,
    update,
    // the heap tree is laid out for the container width: draw it again when that changes (rotation, window resize)
    resize: () => {
      if (cfg.kind === "heap" && last && Math.abs(bodyWidth() - lastWidth) >= 4) update(last.m, last.k);
    },
  };
}
