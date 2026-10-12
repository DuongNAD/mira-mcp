import type { Model } from "../model.js";
import type { TableCfg, Val } from "../types.js";
import { flash, h, setText } from "../ui/dom.js";
import { entriesOf, isDictVal, itemsOf, ndToVal, pyRepr } from "../values.js";
import type { VizInstance } from "./common.js";

const MAX_ROWS = 200;

export function createTable(cfg: TableCfg): VizInstance {
  const wrap = h("div", { class: "tbl-wrap" });
  const note = h("div", { class: "viz-empty" });
  const el = h("div", { class: "viz-table" }, wrap, note);
  note.style.display = "none";
  let prev = new Map<string, string>();
  let shape = "";

  const update = (m: Model, k: number, animate: boolean): void => {
    const raw = m.get(k, cfg.var);
    const v = ndToVal(raw) ?? raw;
    let rows: Array<{ key: string; cells: Array<{ id: string; text: string; full: string }> }> = [];
    let header: string[] = [];
    let extra = 0;
    const cell = (id: string, x: Val | undefined): { id: string; text: string; full: string } => ({ id, text: pyRepr(x, 40, 6), full: pyRepr(x, 400, 40) });
    if (isDictVal(v)) {
      const ent = entriesOf(v) ?? [];
      header = ["Khoá", "Giá trị"];
      rows = ent.slice(0, MAX_ROWS).map(([kk, vv], i) => ({ key: `d${i}`, cells: [cell(`d${i}:k`, kk), cell(`d${i}:v`, vv)] }));
      extra = Math.max(0, ent.length - MAX_ROWS);
    } else {
      const items = itemsOf(v);
      if (items) {
        const matrix = items.length > 0 && items.every((r) => itemsOf(r) !== undefined);
        if (matrix) {
          const width = Math.max(...items.map((r) => itemsOf(r)?.length ?? 0));
          header = ["", ...Array.from({ length: width }, (_, i) => String(i))];
          rows = items.slice(0, MAX_ROWS).map((r, i) => ({
            key: `m${i}`,
            cells: [{ id: `m${i}:i`, text: String(i), full: String(i) }, ...(itemsOf(r) ?? []).map((x, j) => cell(`m${i}:${j}`, x))],
          }));
        } else {
          header = ["Chỉ số", "Giá trị"];
          rows = items.slice(0, MAX_ROWS).map((x, i) => ({ key: `l${i}`, cells: [{ id: `l${i}:i`, text: String(i), full: String(i) }, cell(`l${i}:v`, x)] }));
        }
        extra = Math.max(0, items.length - MAX_ROWS);
      }
    }
    if (rows.length === 0) {
      wrap.style.display = "none";
      note.style.display = "";
      setText(note, v === undefined ? `Chưa có giá trị cho ${cfg.var}` : "Bảng trống");
      return;
    }
    wrap.style.display = "";
    note.style.display = "none";
    const sig = `${header.join("|")}#${rows.length}`;
    if (sig !== shape) {
      shape = sig;
      prev = new Map();
      wrap.textContent = "";
      const thead = h("thead", null, h("tr", null, ...header.map((t) => h("th", { text: t }))));
      const tbody = h("tbody");
      for (const r of rows) {
        const tr = h("tr", { "data-row": r.key });
        r.cells.forEach((c, ci) => tr.appendChild(h("td", { class: ci === 0 && header[0] !== "Khoá" ? "idx mono" : "mono", "data-cell": c.id, text: c.text, title: c.full })));
        tbody.appendChild(tr);
      }
      wrap.appendChild(h("table", { class: "tbl" }, thead, tbody));
      if (extra > 0) wrap.appendChild(h("div", { class: "sv-more", text: `... còn ${extra} dòng nữa` }));
      for (const r of rows) for (const c of r.cells) prev.set(c.id, c.text);
      return;
    }
    const tds = wrap.querySelectorAll("td");
    let n = 0;
    for (const r of rows) {
      for (const c of r.cells) {
        const td = tds[n++] as HTMLElement | undefined;
        if (!td) continue;
        if (prev.get(c.id) !== c.text) {
          td.textContent = c.text;
          td.title = c.full;
          if (animate) flash(td, "flash");
          prev.set(c.id, c.text);
        }
      }
    }
  };

  return { el, update, resize: () => undefined };
}
