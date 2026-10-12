/**
 * Mira player entry. Reads the embedded data (#mira-data), builds the UI and runs the state machine:
 * stepping, autoplay, prediction gates, progress events, embed protocol, deep links (#stop-<k>).
 */
import { comparePrediction } from "./compare.js";
import { blurMessage, eventMessage, hexToRgb, isEmbed, parseHello, postToParent, readyMessage } from "./embed.js";
import {
  type MiraEvent,
  SKIPPED_TEXT,
  completeEvent,
  exportFileName,
  predictEvent,
  pushRing,
  readRing,
  toJsonl,
} from "./events.js";
import { Model } from "./model.js";
import type { PlayerData, StopCfg, Val, VizCfg } from "./types.js";
import { Controls, type TickState } from "./ui/controls.js";
import { clear, h, icon, isReducedMotion, richText } from "./ui/dom.js";
import { Gate, type GateReveal } from "./ui/gate.js";
import { TraceTable } from "./ui/tracetable.js";
import { Caption, CodePane, Counters, StdoutPane, VarsPane, type Banner } from "./ui/panels.js";
import { lengthOf, pyRepr } from "./values.js";
import type { VizInstance } from "./viz/common.js";
import { createViz, vizTitle } from "./viz/index.js";

type StopState = "right" | "different" | "skipped";

/** Short value for captions: scalars as is, containers as type[size]. */
function briefValue(v: Val): string {
  if (v === null || typeof v === "boolean" || typeof v === "number") return pyRepr(v, 20);
  if (typeof v === "string") return pyRepr(v, 22);
  const n = lengthOf(v);
  const text = pyRepr(v, 24, 4);
  if (text.length <= 22 && !text.endsWith("...")) return text;
  const kind = Array.isArray(v) ? "list" : "__tuple__" in v ? "tuple" : "__set__" in v ? "set" : "__dict__" in v || n !== undefined ? "dict" : "obj";
  return n !== undefined ? `${kind}[${n}]` : kind;
}

const THEME_KEY = "mira:theme";

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

class App {
  private readonly m: Model;
  private pos = 0;
  private playing = false;
  private speed = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly states = new Map<number, StopState>();
  private resumeAfterGate = false;
  private completeSent = false;
  private scrubFrom: number | undefined;
  private readonly embed: boolean;
  private readonly storage: Storage | undefined;

  private readonly code: CodePane;
  private readonly vars: VarsPane;
  private readonly stdout: StdoutPane;
  private readonly counters: Counters;
  private readonly caption: Caption;
  private readonly gate: Gate;
  private readonly controls: Controls;
  private readonly app: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly score: HTMLElement;
  private readonly themeBtn: HTMLButtonElement | undefined;
  private readonly vizInstances: VizInstance[] = [];
  private readonly vizPanes: HTMLElement[] = [];
  private readonly vizTabs: HTMLButtonElement[] = [];
  private vizPanel: HTMLElement | undefined;
  private activeViz = 0;
  private traceTable: TraceTable | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly data: PlayerData,
    private readonly win: Window,
  ) {
    this.m = new Model(data);
    this.embed = isEmbed(win);
    this.storage = safeStorage();
    this.code = new CodePane(data);
    this.vars = new VarsPane();
    this.stdout = new StdoutPane(data.stdout);
    this.counters = new Counters(data.counters);
    this.caption = new Caption();
    this.gate = new Gate();
    this.toast = h("span", { class: "toast", role: "status", "aria-live": "polite" });
    this.score = h("span", { class: "score", title: "Số điểm dừng bạn đoán đúng" });
    this.score.style.display = "none";
    this.controls = new Controls(
      {
        first: () => this.go(0, "jump"),
        prev: () => this.go(this.pos - 1, "step"),
        toggle: () => this.toggle(),
        next: () => this.go(this.pos + 1, "step"),
        last: () => this.go(this.m.n - 1, "jump"),
        nextStop: () => this.jumpToNextStop(),
        setSpeed: (v) => {
          this.speed = v;
          this.render(false);
        },
        seekInput: (v) => this.seekInput(v),
        seekChange: (v) => this.seekChange(v),
      },
      this.m.n,
      data.stops.map((s) => s.pos),
    );

    // header
    const actions = h("div", { class: "actions" }, this.score, this.toast);
    if (!this.embed) {
      // icon-only on phones (CSS hides the label), so the accessible name lives on the button itself
      const exportBtn = h(
        "button",
        { class: "chip export-btn", type: "button", title: "Tải tiến độ dự đoán (.jsonl)", "aria-label": "Xuất tiến độ dự đoán (.jsonl)" },
        icon("download", 15),
        h("span", { text: "Xuất tiến độ" }),
      );
      exportBtn.addEventListener("click", () => this.exportProgress());
      actions.appendChild(exportBtn);
      this.themeBtn = h("button", { class: "btn", type: "button", "aria-label": "Đổi giao diện sáng/tối", title: "Đổi giao diện sáng/tối" });
      this.themeBtn.addEventListener("click", () => this.toggleTheme());
      actions.appendChild(this.themeBtn);
    }
    const titles = h("div", { class: "titles" }, h("h1", { text: data.meta.title }));
    if (data.meta.subtitle && !this.embed) titles.appendChild(h("p", { class: "sub mono", text: data.meta.subtitle }));
    const header = h("header", { class: "top" }, titles, actions);

    // viz panel
    const vizPanel = this.buildVizPanel();

    // right column: code, caption, vars, stdout
    const below = h("div", { class: "below" }, this.vars.el, this.stdout.el);
    const side = h("div", { class: "side" }, this.code.el, this.caption.el, below);

    const main = h("main", { class: "main" }, vizPanel, side);
    this.app = h(
      "div",
      { class: `app${data.counters.length ? "" : " no-counters"}`, "data-embed": this.embed ? "1" : "0" },
      header,
      data.counters.length ? this.counters.el : null,
      main,
      this.controls.el,
    );
    this.blurAfterClick(this.controls.el);
    this.blurAfterClick(header);
    root.appendChild(this.app);
    this.applyTheme(this.initialTheme());
  }

  /* ───────── layout helpers ───────── */

  private buildVizPanel(): HTMLElement {
    const panel = h("section", { class: "panel viz", "aria-label": "Trực quan hoá" });
    const head = h("div", { class: "viz-head" });
    const body = h("div", { class: "viz-body" });
    const cfgs = this.data.viz;
    if (cfgs.length === 0) {
      body.appendChild(this.buildInfoPane());
      head.appendChild(h("span", { class: "panel-title", text: "Chương trình" }));
    } else if (cfgs.length === 1) {
      head.appendChild(h("span", { class: "panel-title", text: vizTitle(cfgs[0] as VizCfg) }));
    } else {
      const tabs = h("div", { class: "tabs", role: "tablist" });
      cfgs.forEach((cfg, i) => {
        const t = h("button", { class: "tab", type: "button", role: "tab", text: vizTitle(cfg) });
        t.addEventListener("click", () => this.selectViz(i));
        tabs.appendChild(t);
        this.vizTabs.push(t);
      });
      head.appendChild(tabs);
    }
    cfgs.forEach((cfg, i) => {
      const inst = createViz(cfg);
      const pane = h("div", { class: "viz-pane" }, inst.el);
      pane.style.display = i === 0 ? "" : "none";
      body.appendChild(pane);
      this.vizInstances.push(inst);
      this.vizPanes.push(pane);
    });
    this.vizTabs[0]?.classList.add("on");
    panel.append(head, body, this.gate.el);
    this.vizPanel = panel;
    this.markViz(0);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.vizInstances[this.activeViz]?.resize());
      ro.observe(body);
    }
    return panel;
  }

  /** The panel carries the kind of the shown viz, so the stacked (phone) layout can give a tall one (heap, statevector) room. */
  private markViz(i: number): void {
    const kind = this.data.viz[i]?.kind;
    if (kind) this.vizPanel?.setAttribute("data-viz", kind);
    else this.vizPanel?.removeAttribute("data-viz");
  }

  /** No viz configured: show the call and a trace table (never the result, which a stop may ask for). */
  private buildInfoPane(): HTMLElement {
    const d = this.data;
    const pane = h("div", { class: "info-pane" });
    pane.appendChild(h("div", { class: "info-call mono", text: d.meta.call ?? (d.meta.script ? `chạy ${d.meta.file}` : d.meta.file) }));
    this.traceTable = new TraceTable(this.m);
    pane.appendChild(this.traceTable.el);
    pane.appendChild(h("p", { class: "info-hint", text: "Nhấn → hoặc Space để chạy từng dòng. Điền dự đoán ở các điểm dừng để nhớ lâu hơn." }));
    return pane;
  }

  private selectViz(i: number): void {
    this.activeViz = i;
    this.vizPanes.forEach((p, idx) => {
      p.style.display = idx === i ? "" : "none";
    });
    this.vizTabs.forEach((t, idx) => t.classList.toggle("on", idx === i));
    this.markViz(i);
    this.vizInstances[i]?.resize();
    this.vizInstances[i]?.update(this.m, this.pos, false);
  }

  /* ───────── theme ───────── */

  private initialTheme(): "dark" | "light" {
    try {
      const saved = this.storage?.getItem(THEME_KEY);
      if (saved === "dark" || saved === "light") return saved;
    } catch {
      // ignore
    }
    return this.data.meta.theme;
  }

  private applyTheme(theme: "dark" | "light"): void {
    document.documentElement.setAttribute("data-theme", theme);
    if (this.themeBtn) {
      this.themeBtn.textContent = "";
      this.themeBtn.appendChild(icon(theme === "dark" ? "sun" : "moon", 18));
    }
  }

  private toggleTheme(): void {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    this.applyTheme(next);
    try {
      this.storage?.setItem(THEME_KEY, next);
    } catch {
      // ignore
    }
    this.vizInstances[this.activeViz]?.resize();
  }

  private applyAccent(hex: string): void {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const st = document.documentElement.style;
    st.setProperty("--accent", hex);
    st.setProperty("--accent-rgb", rgb.join(","));
  }

  /* ───────── startup ───────── */

  start(): void {
    this.pos = Math.max(0, Math.min(this.m.n - 1, this.data.meta.startStep));
    this.render(false);
    this.bindKeys();
    this.bindHash();
    if (this.embed) {
      this.win.addEventListener("message", (e: MessageEvent) => {
        const hello = parseHello(e.data);
        if (!hello) return;
        if (hello.theme) this.applyTheme(hello.theme);
        if (hello.accent) this.applyAccent(hello.accent);
      });
      postToParent(this.win, readyMessage({ title: this.data.meta.title, steps: this.m.n, stops: this.data.stops.length }));
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause();
    });
    this.applyHash();
  }

  private bindKeys(): void {
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.embed && e.key === "Escape") {
        postToParent(this.win, blurMessage());
        const a = document.activeElement as HTMLElement | null;
        a?.blur?.();
        return;
      }
      if (this.embed && typeof document.hasFocus === "function" && !document.hasFocus()) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? "";
      if (tag === "INPUT" && (t as HTMLInputElement).type !== "range") return;
      if (tag === "TEXTAREA" || tag === "SELECT") return;
      if (tag === "BUTTON" && (e.key === " " || e.key === "Enter")) return; // native activation of the focused button
      if (this.gate.isOpen) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          this.go(this.pos - 1, "step");
          break;
        case "ArrowRight":
          e.preventDefault();
          this.go(this.pos + 1, "step");
          break;
        case " ":
          e.preventDefault();
          this.toggle();
          break;
        case "Home":
          e.preventDefault();
          this.go(0, "jump");
          break;
        case "End":
          e.preventDefault();
          this.go(this.m.n - 1, "jump");
          break;
        case "n":
        case "N":
          e.preventDefault();
          this.jumpToNextStop();
          break;
        default:
      }
    });
  }

  private bindHash(): void {
    this.win.addEventListener("hashchange", () => this.applyHash());
  }

  /** `#stop-<k>` opens the player at stop k (state just before the gate). */
  private applyHash(): void {
    const hash = this.win.location.hash;
    const mt = /^#stop-(\d+)$/.exec(hash);
    if (!mt) return;
    const stop = this.data.stops.find((s) => s.k === Number(mt[1]));
    if (!stop) return;
    this.pause();
    if (this.gate.isOpen) this.closeGate(false);
    this.states.delete(stop.k);
    this.pos = stop.pos;
    this.render(false);
    this.openGate(stop);
  }

  /* ───────── navigation ───────── */

  private go(target: number, how: "step" | "jump"): void {
    if (this.gate.isOpen) return;
    const n = this.m.n;
    const to = Math.max(0, Math.min(n - 1, target));
    const from = this.pos;
    if (to === from) return;
    if (to > from) {
      for (const s of this.data.stops) {
        if (s.pos > from && s.pos < to && !this.states.has(s.k)) this.skipStop(s);
      }
    }
    this.pos = to;
    this.render(Math.abs(to - from) === 1);
    if (to > from) {
      const stop = this.m.stopAt(to);
      if (stop && !this.states.has(stop.k)) this.openGate(stop);
    }
    if (to === n - 1) this.maybeComplete();
    void how;
  }

  /** Blur buttons after a mouse click so that Space/arrow shortcuts keep working. */
  private blurAfterClick(el: HTMLElement): void {
    el.addEventListener("click", (e) => {
      if ((e as MouseEvent).detail > 0) {
        const b = (e.target as HTMLElement | null)?.closest?.("button");
        b?.blur?.();
      }
    });
  }

  private jumpToNextStop(): void {
    if (this.gate.isOpen) return;
    const i = this.m.nextStopAfter(this.pos);
    const stop = i >= 0 ? this.data.stops[i] : undefined;
    if (stop) {
      this.pause();
      this.go(stop.pos, "jump");
    }
  }

  private seekInput(v: number): void {
    if (this.gate.isOpen) {
      this.render(false);
      return;
    }
    if (this.scrubFrom === undefined) this.scrubFrom = this.pos;
    this.pos = Math.max(0, Math.min(this.m.n - 1, v));
    this.render(false);
  }

  private seekChange(v: number): void {
    const from = this.scrubFrom ?? this.pos;
    this.scrubFrom = undefined;
    if (this.gate.isOpen) {
      this.render(false);
      return;
    }
    this.pos = from;
    this.pause();
    this.go(v, "jump");
  }

  /* ───────── playback ───────── */

  private toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  private play(): void {
    if (this.gate.isOpen) return;
    if (this.pos >= this.m.n - 1) {
      this.pos = 0;
      this.render(false);
    }
    this.playing = true;
    this.render(false);
    this.schedule();
  }

  private pause(): void {
    this.playing = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.render(false);
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const ms = Math.max(40, this.data.meta.autoplayMs / this.speed);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.playing) return;
      if (this.pos >= this.m.n - 1) {
        this.pause();
        return;
      }
      this.go(this.pos + 1, "step");
      if (this.playing && !this.gate.isOpen && this.pos < this.m.n - 1) this.schedule();
      else if (this.pos >= this.m.n - 1) this.pause();
    }, ms);
  }

  /* ───────── prediction gates ───────── */

  private openGate(stop: StopCfg): void {
    this.resumeAfterGate = this.playing;
    if (this.playing) {
      this.playing = false;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.gate.show(stop, this.data.stops.length, {
      check: (input) => this.checkStop(stop, input),
      skip: () => {
        this.skipStop(stop);
        this.closeGate(true);
      },
      done: () => this.closeGate(true),
    });
    this.render(false);
  }

  private closeGate(resume: boolean): void {
    this.gate.hide();
    const again = resume && this.resumeAfterGate;
    this.resumeAfterGate = false;
    this.render(false);
    if (this.pos === this.m.n - 1) this.maybeComplete();
    else if (again) this.play();
  }

  private actualText(stop: StopCfg): { text: string; value: ReturnType<Model["stopOutcome"]> } {
    const outcome = this.m.stopOutcome(stop);
    let text = "(không có dữ liệu)";
    if (stop.kind === "choice") text = stop.choice?.[stop.answer ?? 0] ?? "";
    else if (stop.kind === "line") text = outcome.line !== undefined ? `dòng ${outcome.line}` : text;
    else if (outcome.ok) text = pyRepr(outcome.value, 300, 40);
    return { text, value: outcome };
  }

  private checkStop(stop: StopCfg, input: string): GateReveal {
    const { text: actual, value: outcome } = this.actualText(stop);
    let right = false;
    let typed = input.trim();
    if (stop.kind === "choice") {
      const idx = Number(input);
      right = idx === stop.answer;
      typed = stop.choice?.[idx] ?? input;
    } else if (stop.kind === "line") {
      const mt = /\d+/.exec(input);
      right = mt !== null && outcome.line !== undefined && Number(mt[0]) === outcome.line;
    } else if (outcome.ok) {
      right = comparePrediction(input, outcome.value, stop.tolerance ?? 1e-9).right;
    }
    this.record(stop, right ? "right" : "different", typed, actual);
    const reveal: GateReveal = { right, typed, actual };
    if (stop.explain) reveal.explain = stop.explain;
    return reveal;
  }

  private skipStop(stop: StopCfg): void {
    if (this.states.has(stop.k)) return;
    const { text: actual } = this.actualText(stop);
    this.record(stop, "skipped", SKIPPED_TEXT, actual);
  }

  private record(stop: StopCfg, state: StopState, typed: string, actual: string): void {
    this.states.set(stop.k, state);
    this.emit(
      predictEvent(this.data.meta, stop, {
        t: new Date().toISOString(),
        prediction: typed,
        right: state === "right",
        output: actual,
      }),
    );
    this.renderScore();
    this.renderControls();
  }

  private renderScore(): void {
    const total = this.data.stops.length;
    if (total === 0) return;
    const states = [...this.states.values()];
    const done = states.length;
    if (done === 0) {
      this.score.style.display = "none";
      return;
    }
    const right = states.filter((x) => x === "right").length;
    this.score.style.display = "";
    this.score.textContent = `Dự đoán đúng ${right}/${done}`;
  }

  private maybeComplete(): void {
    if (this.completeSent || this.gate.isOpen) return;
    // every stop is either answered or skipped once the end is reached
    for (const s of this.data.stops) if (!this.states.has(s.k)) this.skipStop(s);
    this.completeSent = true;
    const right = [...this.states.values()].filter((x) => x === "right").length;
    this.emit(completeEvent(this.data.meta, { t: new Date().toISOString(), steps: this.m.n, right, total: this.data.stops.length }));
  }

  /* ───────── progress events ───────── */

  private emit(ev: MiraEvent): void {
    pushRing(this.storage, this.data.meta.slug, ev);
    if (this.embed) {
      postToParent(this.win, eventMessage(ev));
      return;
    }
    const proto = this.win.location.protocol;
    if ((proto === "http:" || proto === "https:") && typeof fetch === "function") {
      try {
        fetch("/__mira/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ev),
          keepalive: true,
        }).catch(() => undefined);
      } catch {
        // the preview server may not be running: the local buffer still has the event
      }
    }
  }

  private exportProgress(): void {
    const events = readRing(this.storage, this.data.meta.slug);
    if (events.length === 0) {
      this.showToast("Chưa có tiến độ để xuất");
      return;
    }
    try {
      const blob = new Blob([toJsonl(events)], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: exportFileName(this.data.meta.slug) });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      this.showToast(`Đã xuất ${events.length} sự kiện`);
    } catch {
      this.showToast("Không xuất được tệp");
    }
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add("on");
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.classList.remove("on");
      this.toast.textContent = "";
    }, 2600);
  }

  /* ───────── rendering ───────── */

  private describe(): { main: string; sub: string } {
    const { m, pos } = this;
    const step = m.steps[pos];
    if (!step) return { main: "", sub: "" };
    const done = m.executedLine(pos);
    const next = m.nextLine(pos);
    const fn = m.funcName(pos);
    let note = "";
    if (step.e === "r") {
      note = step.w ? `${fn}() kết thúc vì lỗi` : fn === "<module>" ? "Chương trình kết thúc" : `${fn}() trả về ${pyRepr(step.v, 80, 6)}`;
    } else if (step.e === "x") {
      note = `Lỗi ${step.ex?.[0] ?? ""}: ${step.ex?.[1] ?? ""}`.trim();
    } else if (m.prevSame[pos] === -1 && fn !== "<module>") {
      const st = m.frameState(pos);
      const names = Object.keys(st.vars).filter((k) => !k.startsWith("@"));
      const args = names
        .slice(0, 4)
        .map((k) => `${k}=${briefValue(st.vars[k] as Val)}`)
        .join(", ");
      note = `Vào hàm ${fn}(${args})`;
    }
    const narr = done > 0 ? (this.data.narration[String(done)] ?? "") : "";
    let nextText = next > 0 ? `Sắp chạy dòng ${next}` : "";
    if (pos === m.n - 1 && this.data.stops.length > 0) {
      const states = [...this.states.values()];
      const right = states.filter((x) => x === "right").length;
      nextText = `Hoàn thành: bạn dự đoán đúng ${right}/${this.data.stops.length} điểm dừng.`;
    }
    if (narr) return { main: narr, sub: note || nextText };
    if (note) return { main: note, sub: nextText };
    if (done > 0) return { main: `Dòng ${done} vừa chạy.`, sub: nextText };
    return { main: "Bắt đầu. Nhấn → hoặc Space để chạy từng dòng.", sub: nextText };
  }

  private tickStates(): TickState[] {
    return this.data.stops.map((s) => this.states.get(s.k) ?? "pending");
  }

  private renderControls(): void {
    this.controls.update(this.pos, this.playing, this.speed, this.tickStates(), this.m.nextStopAfter(this.pos) >= 0);
  }

  private render(animate: boolean): void {
    const { m, pos } = this;
    const step = m.steps[pos];
    if (!step) return;
    const reduced = isReducedMotion();
    const anim = animate && !reduced;
    const st = m.frameState(pos);
    this.code.update(m.executedLine(pos), m.nextLine(pos), m.stackAt(pos), anim);
    const fn = m.funcName(pos);
    let banner: Banner | undefined;
    if (step.e === "r") {
      banner = step.w
        ? { kind: "err", label: "Kết thúc", text: "Hàm thoát vì lỗi" }
        : fn === "<module>"
          ? { kind: "end", label: "Kết thúc", text: "Chương trình đã chạy xong" }
          : { kind: "ret", label: "Trả về", text: pyRepr(step.v, 120, 12) };
    } else if (step.e === "x") {
      banner = { kind: "err", label: "Lỗi", text: `${step.ex?.[0] ?? ""}: ${step.ex?.[1] ?? ""}` };
    }
    this.vars.update(fn === "<module>" ? "mức module" : `${fn}()`, st, banner, anim);
    this.stdout.update(step.o);
    this.counters.update(m, pos, anim);
    this.vizInstances[this.activeViz]?.update(m, pos, anim);
    this.traceTable?.update(pos);
    const cap = this.describe();
    this.caption.set(cap.main, cap.sub);
    this.renderControls();
  }
}

function boot(): void {
  const root = document.getElementById("mira-root");
  const dataEl = document.getElementById("mira-data");
  if (!root || !dataEl) return;
  let data: PlayerData;
  try {
    data = JSON.parse(dataEl.textContent ?? "") as PlayerData;
  } catch {
    clear(root);
    root.textContent = "Dữ liệu của player bị hỏng, hãy tạo lại bằng mira_build.";
    return;
  }
  if (!data || data.v !== 1 || !Array.isArray(data.steps) || data.steps.length === 0) {
    root.textContent = "Player không có bước nào để phát.";
    return;
  }
  new App(root, data, window).start();
}

boot();

// keep the rich-text helper referenced for bundlers that tree-shake aggressively
void richText;
