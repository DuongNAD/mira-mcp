import type { Model } from "../model.js";
import type { Val } from "../types.js";
import { h } from "./dom.js";
import { isNumVal, pyRepr } from "../values.js";
import { isPlainObject } from "../delta.js";

interface Row {
  /** step whose "before" state this row shows */
  step: number;
  /** line that just ran to produce it (0 for the first row) */
  line: number;
  vals: string[];
}

const SHOW = 14;

function scalar(v: Val | undefined): boolean {
  if (v === null) return true;
  if (typeof v === "boolean" || typeof v === "number") return true;
  if (typeof v === "string") return v.length <= 24;
  if (isPlainObject(v)) return isNumVal(v);
  return false;
}

/**
 * The classic exam "trace table": one column per scalar variable of the first traced function, one row each time
 * one of them changes. Rows only appear as the run progresses (never ahead of the current step).
 */
export class TraceTable {
  readonly el: HTMLElement;
  private readonly cols: string[] = [];
  private readonly rows: Row[] = [];
  private readonly body: HTMLElement;
  private readonly head: HTMLElement;
  private shown = -2;

  constructor(m: Model) {
    const first = m.steps[0];
    const ownSteps: number[] = [];
    if (first) m.steps.forEach((s, k) => s.x === first.x && s.e === "l" && ownSteps.push(k));
    // pick columns: scalar variables with the most distinct values, in order of first appearance
    const info = new Map<string, { order: number; seen: Set<string> }>();
    for (const k of ownSteps) {
      const st = m.frameState(k);
      for (const name of Object.keys(st.vars)) {
        if (name.startsWith("@")) continue;
        const v = st.vars[name] as Val;
        if (!scalar(v)) continue;
        let e = info.get(name);
        if (!e) {
          e = { order: info.size, seen: new Set() };
          info.set(name, e);
        }
        if (e.seen.size < 50) e.seen.add(pyRepr(v, 30));
      }
    }
    const varying = [...info.entries()].filter(([, e]) => e.seen.size > 1);
    const pool = (varying.length ? varying : [...info.entries()]).sort((a, b) => a[1].order - b[1].order);
    this.cols.push(...pool.slice(0, 5).map(([n]) => n));

    let prev = "";
    for (const k of ownSteps) {
      const st = m.frameState(k);
      const vals = this.cols.map((c) => (c in st.vars ? pyRepr(st.vars[c] as Val, 18) : ""));
      const key = vals.join("\u0001");
      if (key !== prev) {
        this.rows.push({ step: k, line: m.executedLine(k), vals });
        prev = key;
      }
    }

    this.head = h("tr", null, h("th", { text: "Dòng" }), ...this.cols.map((c) => h("th", { class: "mono", text: c })));
    this.body = h("tbody");
    this.el = h(
      "div",
      { class: "trace" },
      h("div", { class: "trace-title", text: "Bảng dò vết" }),
      h("div", { class: "tbl-wrap" }, h("table", { class: "tbl trace-tbl" }, h("thead", null, this.head), this.body)),
    );
    if (this.cols.length === 0) this.el.style.display = "none";
  }

  /** Rows up to and including step k, the last SHOW of them. */
  update(k: number): void {
    let n = 0;
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.rows[mid] as Row).step <= k) lo = mid + 1;
      else hi = mid;
    }
    n = lo;
    if (n === this.shown) return;
    this.shown = n;
    this.body.textContent = "";
    const from = Math.max(0, n - SHOW);
    if (from > 0) this.body.appendChild(h("tr", { class: "gap" }, h("td", { colspan: String(this.cols.length + 1), text: `... ${from} dòng trước đó` })));
    for (let i = from; i < n; i++) {
      const r = this.rows[i] as Row;
      const tr = h("tr", { class: i === n - 1 ? "cur" : "" }, h("td", { class: "idx mono", text: r.line ? String(r.line) : "-" }), ...r.vals.map((v) => h("td", { class: "mono", text: v })));
      this.body.appendChild(tr);
    }
    const wrap = this.body.parentNode?.parentNode as HTMLElement | null;
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
}
