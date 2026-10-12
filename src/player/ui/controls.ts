import { h, icon, setText } from "./dom.js";

export type TickState = "pending" | "right" | "different" | "skipped";

export interface ControlsApi {
  first(): void;
  prev(): void;
  toggle(): void;
  next(): void;
  last(): void;
  nextStop(): void;
  setSpeed(v: number): void;
  seekInput(pos: number): void;
  seekChange(pos: number): void;
}

const SPEEDS = [0.5, 1, 2, 4];

function iconButton(name: string, label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", { class: `btn ${cls}`, type: "button", "aria-label": label, title: label }, icon(name, name === "play" || name === "pause" ? 20 : 18));
  b.addEventListener("click", onClick);
  return b;
}

export class Controls {
  readonly el: HTMLElement;
  private readonly range: HTMLInputElement;
  private readonly ticks: HTMLElement[] = [];
  private readonly stepNo: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly speedBtns: HTMLButtonElement[] = [];
  private lastPlaying: boolean | undefined;

  constructor(
    private readonly api: ControlsApi,
    private readonly n: number,
    stopPositions: number[],
  ) {
    const first = iconButton("first", "Về bước đầu (Home)", "", () => api.first());
    const prev = iconButton("prev", "Bước trước (←)", "", () => api.prev());
    this.playBtn = iconButton("play", "Chạy tự động (Space)", "play", () => api.toggle());
    const next = iconButton("next", "Bước kế tiếp (→)", "", () => api.next());
    const last = iconButton("last", "Tới bước cuối (End)", "", () => api.last());
    // phones show only "Điểm dừng" (CSS hides .more), so the full name lives in the aria-label
    this.stopBtn = h(
      "button",
      { class: "chip stop-btn", type: "button", title: "Nhảy tới điểm dừng tiếp theo (N)", "aria-label": "Nhảy tới điểm dừng tiếp theo (N)" },
      icon("flag", 15),
      h("span", null, "Điểm dừng", h("span", { class: "more", text: " tiếp theo" })),
    );
    this.stopBtn.addEventListener("click", () => api.nextStop());
    const noStops = stopPositions.length === 0;
    if (noStops) this.stopBtn.style.display = "none";

    this.range = h("input", { class: "scrub-range", type: "range", min: "0", max: String(Math.max(0, n - 1)), step: "1", value: "0", "aria-label": "Thanh tua các bước" });
    this.range.addEventListener("input", () => api.seekInput(Number(this.range.value)));
    this.range.addEventListener("change", () => api.seekChange(Number(this.range.value)));
    const tickLayer = h("div", { class: "ticks", "aria-hidden": "true" });
    for (const pos of stopPositions) {
      const t = h("i", { class: "tick pending" });
      t.style.left = n > 1 ? `${(pos / (n - 1)) * 100}%` : "0%";
      tickLayer.appendChild(t);
      this.ticks.push(t);
    }
    const scrub = h("div", { class: "scrub" }, h("div", { class: "scrub-track" }, tickLayer, this.range));

    this.stepNo = h("span", { class: "stepno mono" });
    const speed = h("div", { class: "speed", role: "group", "aria-label": "Tốc độ" });
    for (const v of SPEEDS) {
      const b = h("button", { class: "seg", type: "button", text: `${v}×`, title: `Tốc độ ${v}×` });
      b.addEventListener("click", () => api.setSpeed(v));
      this.speedBtns.push(b);
      speed.appendChild(b);
    }
    this.el = h(
      "footer",
      { class: `controls${noStops ? " no-stops" : ""}` },
      h("div", { class: "ctl-buttons" }, first, prev, this.playBtn, next, last),
      this.stopBtn,
      scrub,
      h("div", { class: "ctl-side" }, this.stepNo, speed),
    );
  }

  update(pos: number, playing: boolean, speed: number, ticks: TickState[], nextStopAvailable: boolean): void {
    if (this.range.value !== String(pos)) this.range.value = String(pos);
    this.range.style.setProperty("--p", `${this.n > 1 ? ((pos / (this.n - 1)) * 100).toFixed(2) : 0}%`);
    setText(this.stepNo, `Bước ${pos + 1}/${this.n}`);
    if (playing !== this.lastPlaying) {
      this.lastPlaying = playing;
      this.playBtn.textContent = "";
      this.playBtn.appendChild(icon(playing ? "pause" : "play", 20));
      const label = playing ? "Tạm dừng (Space)" : "Chạy tự động (Space)";
      this.playBtn.setAttribute("aria-label", label);
      this.playBtn.title = label;
    }
    this.speedBtns.forEach((b, i) => b.classList.toggle("on", SPEEDS[i] === speed));
    ticks.forEach((state, i) => {
      const t = this.ticks[i];
      if (t) t.className = `tick ${state}`;
    });
    this.stopBtn.disabled = !nextStopAvailable;
    void this.api;
  }
}
