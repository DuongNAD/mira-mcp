import type { Model } from "../model.js";
import type { GraphCfg, Val } from "../types.js";
import { h, s, setText } from "../ui/dom.js";
import { entriesOf, isDictVal, itemsOf, keyText, numOf, pyRepr } from "../values.js";
import { type VizInstance, shortNum, svgSpace } from "./common.js";

/** Legacy drawing box; a narrow container (a phone) is laid out in its real pixels instead, see svgSpace. */
const BASE_W = 600;
const BASE_H = 400;

interface GNode {
  key: string;
  x: number;
  y: number;
}
interface GEdge {
  a: string;
  b: string;
  w?: string;
  directed: boolean;
}

function parseGraph(nodesV: Val | undefined, adjV: Val | undefined, W: number, H: number): { nodes: GNode[]; edges: GEdge[] } | undefined {
  const order: string[] = [];
  const pos = new Map<string, [number, number]>();
  const addNode = (k: string): void => {
    if (!order.includes(k)) order.push(k);
  };
  if (nodesV !== undefined) {
    const ent = entriesOf(nodesV);
    if (ent) {
      for (const [idV, info] of ent) {
        const key = keyText(idV);
        addNode(key);
        const infoEnt = entriesOf(info);
        let x: number | undefined;
        let y: number | undefined;
        if (infoEnt) {
          for (const [kk, vv] of infoEnt) {
            if (kk === "x") x = numOf(vv);
            if (kk === "y") y = numOf(vv);
          }
        } else {
          const it = itemsOf(info);
          if (it && it.length >= 2) {
            x = numOf(it[0]);
            y = numOf(it[1]);
          }
        }
        if (x !== undefined && y !== undefined) pos.set(key, [x, y]);
      }
    } else {
      for (const idV of itemsOf(nodesV) ?? []) addNode(keyText(idV));
    }
  }
  const raw: Array<{ a: string; b: string; w?: string }> = [];
  const adjEnt = adjV !== undefined ? entriesOf(adjV) : undefined;
  if (adjEnt) {
    for (const [uV, nbrs] of adjEnt) {
      const u = keyText(uV);
      addNode(u);
      const dictNbrs = entriesOf(nbrs);
      if (dictNbrs && isDictVal(nbrs)) {
        for (const [vV, wV] of dictNbrs) {
          const v = keyText(vV);
          addNode(v);
          raw.push({ a: u, b: v, w: typeof wV === "number" ? shortNum(wV) : undefined } as { a: string; b: string; w?: string });
        }
        continue;
      }
      for (const item of itemsOf(nbrs) ?? []) {
        const pair = itemsOf(item);
        if (pair && pair.length === 2 && numOf(pair[1]) !== undefined) {
          const v = keyText(pair[0] as Val);
          addNode(v);
          raw.push({ a: u, b: v, w: shortNum(numOf(pair[1]) as number) });
        } else {
          const v = keyText(item);
          addNode(v);
          raw.push({ a: u, b: v });
        }
      }
    }
  }
  if (order.length === 0) return undefined;
  const hasPos = order.every((k) => pos.has(k));
  const nodes: GNode[] = [];
  if (hasPos) {
    const xs = order.map((k) => (pos.get(k) as [number, number])[0]);
    const ys = order.map((k) => (pos.get(k) as [number, number])[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = Math.min(46, Math.round(Math.min(W, H) * 0.12));
    const sx = maxX > minX ? (W - pad * 2) / (maxX - minX) : 0;
    const sy = maxY > minY ? (H - pad * 2) / (maxY - minY) : 0;
    const sc = sx && sy ? Math.min(sx, sy) : sx || sy || 1;
    const ox = (W - (maxX - minX) * sc) / 2;
    const oy = (H - (maxY - minY) * sc) / 2;
    for (const k of order) {
      const p = pos.get(k) as [number, number];
      nodes.push({ key: k, x: ox + (p[0] - minX) * sc, y: oy + (p[1] - minY) * sc });
    }
  } else {
    const n = order.length;
    const r = n === 1 ? 0 : Math.min(W, H) * 0.36;
    order.forEach((k, i) => {
      const ang = -Math.PI / 2 + (2 * Math.PI * i) / n;
      nodes.push({ key: k, x: W / 2 + r * Math.cos(ang) * (W / H > 1 ? 1.35 : 1), y: H / 2 + r * Math.sin(ang) });
    });
  }
  const seen = new Set(raw.map((e) => `${e.a}|${e.b}`));
  const edges: GEdge[] = [];
  const done = new Set<string>();
  for (const e of raw) {
    const id = `${e.a}|${e.b}`;
    const rev = `${e.b}|${e.a}`;
    if (done.has(id) || done.has(rev)) continue;
    done.add(id);
    const edge: GEdge = { a: e.a, b: e.b, directed: !seen.has(rev) };
    if (e.w !== undefined) edge.w = e.w;
    edges.push(edge);
  }
  return { nodes, edges };
}

function keySet(v: Val | undefined, known: Set<string>): Set<string> {
  const out = new Set<string>();
  if (v === undefined) return out;
  if (isDictVal(v)) {
    for (const [k] of entriesOf(v) ?? []) out.add(keyText(k));
    return out;
  }
  const items = itemsOf(v);
  if (!items) {
    out.add(keyText(v));
    return out;
  }
  for (const item of items) {
    const sub = itemsOf(item);
    if (sub && sub.length > 0) {
      // heap entries such as (dist, node): prefer the last element, else the first known id
      const last = keyText(sub[sub.length - 1] as Val);
      if (known.has(last)) out.add(last);
      else {
        const first = sub.map((x) => keyText(x)).find((x) => known.has(x));
        if (first !== undefined) out.add(first);
      }
    } else {
      out.add(keyText(item));
    }
  }
  return out;
}

export function createGraph(cfg: GraphCfg): VizInstance {
  let W = BASE_W;
  let H = BASE_H;
  const svg = s("svg", { class: "graph-svg", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", role: "img" });
  const note = h("div", { class: "viz-empty" });
  const el = h("div", { class: "viz-graph" }, svg, note);
  note.style.display = "none";
  let topoKey = "";
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
  const circles = new Map<string, SVGGElement>();
  const labelEls = new Map<string, SVGTextElement>();
  const legend = h("div", { class: "legend" });
  if (cfg.visited) legend.appendChild(h("span", { class: "lg-item" }, h("i", { class: "lg-dot lg-visited" }), "Đã xét"));
  if (cfg.frontier) legend.appendChild(h("span", { class: "lg-item" }, h("i", { class: "lg-dot lg-frontier" }), "Hàng đợi"));
  if (cfg.current) legend.appendChild(h("span", { class: "lg-item" }, h("i", { class: "lg-dot lg-current" }), "Đang xét"));
  el.appendChild(legend);

  const rebuild = (g: { nodes: GNode[]; edges: GEdge[] }): void => {
    svg.textContent = "";
    circles.clear();
    labelEls.clear();
    const defs = s("defs");
    const marker = s(
      "marker",
      { id: "garrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
      s("path", { d: "M0 1 L10 5 L0 9 z", class: "garrow" }),
    );
    defs.appendChild(marker);
    svg.appendChild(defs);
    const byKey = new Map(g.nodes.map((n) => [n.key, n]));
    // 19 / 15 / 11 by node count, but never more than 6% of the short side (only bites in a small container)
    const r = Math.max(8, Math.min(g.nodes.length > 24 ? 11 : g.nodes.length > 12 ? 15 : 19, Math.round(Math.min(W, H) * 0.06)));
    const edgeLayer = s("g", { class: "gedges" });
    const nodeLayer = s("g", { class: "gnodes" });
    for (const e of g.edges) {
      const a = byKey.get(e.a);
      const b = byKey.get(e.b);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const x1 = a.x + ux * r;
      const y1 = a.y + uy * r;
      const x2 = b.x - ux * (r + (e.directed ? 3 : 0));
      const y2 = b.y - uy * (r + (e.directed ? 3 : 0));
      edgeLayer.appendChild(
        s("line", { class: "gedge", x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1), "marker-end": e.directed ? "url(#garrow)" : null }),
      );
      if (e.w !== undefined) {
        edgeLayer.appendChild(s("text", { class: "gweight", x: ((a.x + b.x) / 2).toFixed(1), y: ((a.y + b.y) / 2 - 5).toFixed(1), "text-anchor": "middle", text: e.w }));
      }
    }
    for (const n of g.nodes) {
      const grp = s("g", { class: "gnode", transform: `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})` });
      grp.appendChild(s("circle", { r }));
      grp.appendChild(s("text", { class: "gid", "text-anchor": "middle", dy: "0.35em", text: n.key.length > 4 ? `${n.key.slice(0, 3)}...` : n.key }));
      const lab = s("text", { class: "glabel", "text-anchor": "middle", y: r + 14, text: "" });
      grp.appendChild(lab);
      nodeLayer.appendChild(grp);
      circles.set(n.key, grp);
      labelEls.set(n.key, lab);
    }
    svg.appendChild(edgeLayer);
    svg.appendChild(nodeLayer);
  };

  const update = (m: Model, k: number): void => {
    last = { m, k };
    svg.style.display = ""; // it must be laid out to be measured
    fit();
    const nodesV = cfg.nodes ? m.evalAt(k, cfg.nodes) : undefined;
    const adjV = cfg.adjacency ? m.evalAt(k, cfg.adjacency) : undefined;
    const g = parseGraph(nodesV, adjV, W, H);
    if (!g) {
      svg.style.display = "none";
      note.style.display = "";
      setText(note, "Chưa có đồ thị để vẽ");
      return;
    }
    note.style.display = "none";
    const key = JSON.stringify([W, H, g.nodes.map((n) => [n.key, Math.round(n.x), Math.round(n.y)]), g.edges.map((e) => [e.a, e.b, e.w ?? ""])]);
    if (key !== topoKey) {
      topoKey = key;
      rebuild(g);
    }
    const known = new Set(g.nodes.map((n) => n.key));
    const visited = cfg.visited ? keySet(m.evalAt(k, cfg.visited), known) : new Set<string>();
    const frontier = cfg.frontier ? keySet(m.evalAt(k, cfg.frontier), known) : new Set<string>();
    const current = cfg.current ? keySet(m.evalAt(k, cfg.current), known) : new Set<string>();
    const labelsV = cfg.labels ? m.evalAt(k, cfg.labels) : undefined;
    const labelMap = new Map<string, Val>();
    for (const [lk, lv] of entriesOf(labelsV) ?? []) labelMap.set(keyText(lk), lv);
    for (const [nodeKey, grp] of circles) {
      grp.classList.toggle("current", current.has(nodeKey));
      grp.classList.toggle("visited", visited.has(nodeKey));
      grp.classList.toggle("frontier", frontier.has(nodeKey) && !visited.has(nodeKey));
      const lab = labelEls.get(nodeKey);
      if (lab) {
        const lv = labelMap.get(nodeKey);
        setText(lab, lv === undefined ? "" : typeof lv === "number" ? shortNum(lv) : pyRepr(lv, 10, 2));
      }
    }
  };

  return {
    el,
    update,
    resize: () => {
      if (fit() && last) update(last.m, last.k);
    },
  };
}
