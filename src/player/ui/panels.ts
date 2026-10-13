import type { FrameState, Model } from "../model.js";
import type { CounterCfg, PlayerData, Val } from "../types.js";
import { flash, h, isReducedMotion, setText } from "./dom.js";
import { numOf, pyRepr } from "../values.js";

/* ───────── code window ───────── */

export class CodePane {
  readonly el: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly rows: HTMLElement[] = [];
  private readonly stackEl: HTMLElement;
  private doneRow = -1;
  private nextRow = -1;
  private stackText = "";

  constructor(data: PlayerData, captionEl: HTMLElement) {
    this.stackEl = h("span", { class: "win-stack mono" });
    const bar = h(
      "div",
      { class: "win-bar" },
      h("span", { class: "win-title mono", text: data.meta.file }),
      this.stackEl,
    );
    this.scroller = h("div", { class: "code-scroll mono", tabindex: "-1" });
    data.source.forEach((line, i) => {
      const match = line.match(/^[ \t]*/);
      const raw = match ? match[0].replace(/\t/g, "    ") : "";
      const indent = raw.length + 4;
      const tx = h("span", {
        class: "tx mono",
        style: {
          "padding-left": `${indent}ch`,
          "text-indent": `-${indent}ch`,
        },
      });
      tx.innerHTML = data.hl[i] ?? "";
      const row = h(
        "div",
        { class: "ln", "data-n": String(i + 1) },
        h("span", { class: "no mono", text: String(i + 1) }),
        tx,
      );
      this.rows.push(row);
      this.scroller.appendChild(row);
    });
    this.el = h("section", { class: "panel code", "aria-label": "Mã nguồn" }, bar, this.scroller, captionEl);

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (this.scroller.clientHeight > 0) {
          this.revealActive(false);
        }
      });
      ro.observe(this.scroller);
    }
  }

  revealActive(smooth = false, gateEl?: HTMLElement): void {
    const focus = this.nextRow >= 0 ? this.nextRow : this.doneRow;
    if (focus >= 0) this.reveal(focus, smooth, gateEl);
  }

  /** `done` = line that just ran, `next` = line about to run (1-based, 0 = none). */
  update(done: number, next: number, stack: string[], smooth: boolean, gateEl?: HTMLElement): void {
    const d = done > 0 ? done - 1 : -1;
    const n = next > 0 ? next - 1 : -1;
    if (d !== this.doneRow) {
      this.rows[this.doneRow]?.classList.remove("done");
      this.rows[d]?.classList.add("done");
      this.doneRow = d;
    }
    if (n !== this.nextRow) {
      this.rows[this.nextRow]?.classList.remove("next");
      this.rows[n]?.classList.add("next");
      this.nextRow = n;
    }
    const text = stack.length ? stack.map((f) => (f === "<module>" ? "módulo" : `${f}()`)).join(" › ") : "";
    if (text !== this.stackText) {
      this.stackText = text;
      setText(this.stackEl, text);
    }
    const focus = n >= 0 ? n : d;
    if (focus >= 0) this.reveal(focus, smooth, gateEl);
  }

  /** Scrolls only the code pane (never the page) so that the row stays comfortably visible and centered. */
  reveal(index: number, smooth: boolean, gateEl?: HTMLElement): void {
    const row = this.rows[index];
    if (!row) return;
    const sc = this.scroller;
    const view = sc.clientHeight;
    if (!view) {
      requestAnimationFrame(() => this.reveal(index, false, gateEl));
      return;
    }
    const top = row.offsetTop;
    const hh = row.offsetHeight;

    let visibleHeight = view;
    if (gateEl && gateEl.style.display !== "none") {
      try {
        const scRect = sc.getBoundingClientRect();
        const gateRect = gateEl.getBoundingClientRect();
        if (gateRect.top > scRect.top && gateRect.top < scRect.bottom) {
          visibleHeight = Math.max(60, gateRect.top - scRect.top);
        }
      } catch {
        // fallback
      }
    }
    const target = Math.max(0, Math.min(sc.scrollHeight - view, top - (visibleHeight - hh) / 2));
    if (typeof sc.scrollTo === "function") {
      sc.scrollTo({ top: target, behavior: smooth && !isReducedMotion() ? "smooth" : "auto" });
    } else {
      sc.scrollTop = target;
    }
  }
}

/* ───────── variables ───────── */

interface Row {
  el: HTMLElement;
  val: HTMLElement;
  type: HTMLElement;
  text: string;
  typ: string;
  /** last rendered value; identical references mean "unchanged" (the model shares unchanged values) */
  ref?: Val;
}

export interface Banner {
  kind: "ret" | "err" | "end";
  label: string;
  text: string;
}

export class VarsPane {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly frameLabel: HTMLElement;
  private readonly banner: HTMLElement;
  private rows = new Map<string, Row>();
  private names: string[] = [];

  constructor() {
    this.frameLabel = h("span", { class: "vars-frame mono" });
    this.banner = h("div", { class: "banner" });
    this.banner.style.display = "none";
    this.body = h("div", { class: "vars-body", role: "list" });
    this.el = h(
      "section",
      { class: "panel vars", "aria-label": "Biến" },
      h("div", { class: "panel-head" }, h("span", { class: "panel-title", text: "Biến" }), this.frameLabel),
      this.banner,
      this.body,
    );
  }

  update(frame: string, st: FrameState, banner: Banner | undefined, animate: boolean): void {
    setText(this.frameLabel, frame);
    if (banner) {
      this.banner.style.display = "";
      this.banner.className = `banner ${banner.kind}`;
      this.banner.textContent = "";
      this.banner.appendChild(h("span", { class: "banner-label", text: banner.label }));
      this.banner.appendChild(h("span", { class: "banner-text mono", text: banner.text }));
    } else {
      this.banner.style.display = "none";
    }
    const all = Object.keys(st.vars);
    const names = [...all.filter((n) => !n.startsWith("@")), ...all.filter((n) => n.startsWith("@"))];
    const same = names.length === this.names.length && names.every((n, i) => n === this.names[i]);
    if (!same) {
      this.body.textContent = "";
      this.rows.clear();
      this.names = names;
      if (names.length === 0) {
        this.body.appendChild(h("div", { class: "vars-empty", text: "Chưa có biến nào trong khung này" }));
      }
      for (const name of names) {
        const probe = name.startsWith("@");
        const val = h("span", { class: "vv mono" });
        const type = h("span", { class: "vt" });
        const el = h("div", { class: `vr${probe ? " probe" : ""}`, role: "listitem" }, h("span", { class: "vn mono", text: probe ? name.slice(1) : name }), val, type);
        this.body.appendChild(el);
        this.rows.set(name, { el, val, type, text: "", typ: "" });
      }
    }
    const changed = new Set(st.changed);
    let firstChanged: HTMLElement | undefined;
    for (const name of names) {
      const row = this.rows.get(name);
      if (!row) continue;
      const v = st.vars[name] as Val;
      if (row.ref !== v || row.text === "") {
        row.ref = v;
        const text = pyRepr(v, 300, 20);
        if (text !== row.text) {
          row.text = text;
          row.val.textContent = text;
          row.val.title = pyRepr(v, 600, 60);
        }
      }
      const typ = name.startsWith("@") ? "probe" : (st.types[name] ?? "");
      if (typ !== row.typ) {
        row.typ = typ;
        row.type.textContent = typ;
      }
      if (animate && changed.has(name)) {
        flash(row.el, "flash");
        firstChanged ??= row.el;
      }
    }
    if (firstChanged) this.reveal(firstChanged);
  }

  /** Scrolls only this pane so that a changed row is visible. */
  private reveal(row: HTMLElement): void {
    const body = this.body;
    const view = body.clientHeight;
    if (!view) return;
    const top = row.offsetTop;
    const hh = row.offsetHeight;
    if (top >= body.scrollTop && top + hh <= body.scrollTop + view) return;
    const target = Math.max(0, Math.min(body.scrollHeight - view, top - 6));
    if (typeof body.scrollTo === "function") body.scrollTo({ top: target, behavior: isReducedMotion() ? "auto" : "smooth" });
    else body.scrollTop = target;
  }
}

/* ───────── stdout ───────── */

export class StdoutPane {
  readonly el: HTMLElement;
  private readonly pre: HTMLElement;
  private shown = -1;

  constructor(private readonly full: string) {
    this.pre = h("pre", { class: "out-pre mono" });
    this.el = h("section", { class: "panel out", "aria-label": "Đầu ra" }, h("div", { class: "panel-head" }, h("span", { class: "panel-title", text: "Đầu ra" })), this.pre);
    this.el.style.display = "none";
  }

  update(count: number): void {
    if (count === this.shown) return;
    const grew = count > this.shown;
    this.shown = count;
    const text = this.full.slice(0, count);
    this.pre.textContent = text;
    this.pre.classList.toggle("empty", text === "");
    if (text === "") {
      this.pre.setAttribute("data-empty", "(chưa có đầu ra)");
      this.el.style.display = "none";
    } else {
      this.el.style.display = "";
    }
    if (grew) this.pre.scrollTop = this.pre.scrollHeight;
  }
}

/* ───────── counters ───────── */

export class Counters {
  readonly el: HTMLElement;
  private readonly items: Array<{ cfg: CounterCfg; val: HTMLElement; text: string }> = [];

  constructor(cfgs: CounterCfg[]) {
    this.el = h("div", { class: "counters", "aria-label": "Bộ đếm" });
    const limited = cfgs.slice(0, 4);
    for (const cfg of limited) {
      const val = h("span", { class: "ctr-val mono", text: "-" });
      const label = h("span", { class: "ctr-label", text: cfg.label });
      this.el.appendChild(h("div", { class: "ctr" }, val, label));
      this.items.push({ cfg, val, text: "" });
    }
    if (limited.length === 0) this.el.style.display = "none";
  }

  update(m: Model, k: number, animate: boolean): void {
    for (const it of this.items) {
      let text = "-";
      if (it.cfg.lineHits !== undefined) {
        text = fmt(m.hitsUpTo(it.cfg.lineHits, k));
      } else if (it.cfg.expr) {
        const v = m.evalAt(k, it.cfg.expr);
        if (v !== undefined) {
          const n = numOf(v);
          text = n !== undefined && typeof v !== "boolean" ? fmt(n) : pyRepr(v, 24, 4);
        }
      }
      if (text !== it.text) {
        const first = it.text === "";
        it.text = text;
        it.val.textContent = text;
        if (animate && !first) flash(it.val, "bump");
      }
    }
  }
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) {
    try {
      return n.toLocaleString("vi-VN");
    } catch {
      return String(n);
    }
  }
  return String(Number(n.toPrecision(6)));
}

/* ───────── caption ───────── */

export class Caption {
  readonly el: HTMLElement;
  private readonly main: HTMLElement;
  private readonly sub: HTMLElement;

  constructor() {
    this.main = h("div", { class: "cap-main" });
    this.sub = h("div", { class: "cap-sub" });
    this.el = h("section", { class: "caption", role: "status", "aria-live": "polite" }, this.main, this.sub);
  }

  set(main: string, sub: string): void {
    setText(this.main, main);
    setText(this.sub, sub);
  }
}
