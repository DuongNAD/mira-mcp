import { deepEqual } from "../delta.js";
import type { Model } from "../model.js";
import type { ArrayCfg, Val } from "../types.js";
import { flash, h, setText } from "../ui/dom.js";
import { itemsOf, ndarrayOf, numOf, numOfLoose, pyRepr } from "../values.js";
import { type VizInstance, shortNum } from "./common.js";

interface Col {
  el: HTMLElement;
  val: HTMLElement;
  bar?: HTMLElement;
  idx: HTMLElement;
  ptr: HTMLElement;
}

/** Items of a list-like or numpy value. */
export function arrayItems(v: Val | undefined): Val[] | undefined {
  const items = itemsOf(v);
  if (items) return items;
  const nd = ndarrayOf(v);
  if (nd?.data && nd.shape.length <= 1 && !nd.dtype.startsWith("complex")) return nd.data;
  return undefined;
}

export function createArray(cfg: ArrayCfg): VizInstance {
  const track = h("div", { class: "arr" });
  const empty = h("div", { class: "viz-empty" });
  const el = h("div", { class: "viz-array" }, track, empty);
  let cols: Col[] = [];
  let mode: "bars" | "cells" | "" = "";
  let prev: Val[] = [];

  const build = (n: number, m: "bars" | "cells"): void => {
    track.textContent = "";
    cols = [];
    mode = m;
    track.className = `arr arr-${m}${n > 60 ? " dense" : ""}${n > 120 ? " xdense" : ""}`;
    for (let i = 0; i < n; i++) {
      const val = h("div", { class: "aval" });
      const idx = h("div", { class: "aidx", text: String(i) });
      const ptr = h("div", { class: "aptr" });
      if (m === "bars") {
        const fill = h("i");
        const bar = h("div", { class: "abar" }, fill);
        const col = h("div", { class: "acol" }, val, bar, idx, ptr);
        track.appendChild(col);
        cols.push({ el: col, val, bar: fill, idx, ptr });
      } else {
        const col = h("div", { class: "acell" }, idx, val, ptr);
        track.appendChild(col);
        cols.push({ el: col, val, idx, ptr });
      }
    }
  };

  const update = (m: Model, k: number, animate: boolean): void => {
    const v = m.get(k, cfg.var);
    const items = arrayItems(v);
    if (!items) {
      track.style.display = "none";
      empty.style.display = "";
      setText(empty, v === undefined ? `Chưa có giá trị cho ${cfg.var}` : `${cfg.var} không phải danh sách`);
      return;
    }
    track.style.display = "";
    empty.style.display = "none";
    const nums = items.map((x) => (typeof x === "string" ? numOfLoose(x) : numOf(x)));
    const allNum = items.length > 0 && items.every((x, i) => typeof x !== "boolean" && Number.isFinite(nums[i] as number));
    const want: "bars" | "cells" = allNum ? "bars" : "cells";
    if (cols.length !== items.length || mode !== want) {
      build(items.length, want);
      prev = [];
    }
    const maxAbs = allNum ? Math.max(1e-12, ...nums.map((x) => Math.abs(x as number))) : 1;
    const pointerAt = new Map<number, string[]>();
    for (const name of cfg.pointers ?? []) {
      const p = numOf(m.get(k, name));
      if (p !== undefined && Number.isInteger(p) && p >= 0 && p < items.length) {
        const arr = pointerAt.get(p) ?? [];
        arr.push(name);
        pointerAt.set(p, arr);
      }
    }
    const showVal = items.length <= 40;
    for (let i = 0; i < items.length; i++) {
      const col = cols[i] as Col;
      const x = items[i] as Val;
      const changed = prev.length === items.length && !deepEqual(prev[i], x);
      if (allNum) {
        const n = nums[i] as number;
        const pct = Math.max(3, (Math.abs(n) / maxAbs) * 100);
        (col.bar as HTMLElement).style.height = `${pct}%`;
        col.el.classList.toggle("neg", n < 0);
        setText(col.val, showVal ? shortNum(n) : "");
      } else {
        setText(col.val, pyRepr(x, 14, 3));
        col.val.title = pyRepr(x, 200);
      }
      const ptrs = pointerAt.get(i);
      setText(col.ptr, ptrs ? ptrs.join(",") : "");
      col.el.classList.toggle("ptr", Boolean(ptrs));
      if (changed && animate) flash(col.el, "flash");
    }
    prev = items;
  };

  return { el, update, resize: () => undefined };
}
