import type { StopCfg } from "../types.js";
import { h, icon, isReducedMotion, richText } from "./dom.js";

/**
 * On a phone the page scrolls and a sticky bar covers its bottom edge, while the gate sits in the viz panel near the
 * top of the page: when it opens (or grows with the answer) it may be out of sight. Bring it into view, clear of the
 * bar (the `scroll-margin` of .gate). In the side-by-side layout the page does not scroll and this does nothing.
 */
function bringIntoView(el: HTMLElement): void {
  try {
    const de = document.documentElement;
    if (de.scrollHeight <= de.clientHeight + 1) return;
    if (typeof el.scrollIntoView !== "function") return;
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: isReducedMotion() ? "auto" : "smooth" });
  } catch {
    // purely cosmetic
  }
}

export interface GateReveal {
  right: boolean;
  /** what the learner typed (shown back) */
  typed: string;
  /** the real value, as text */
  actual: string;
  explain?: string;
}

export interface GateHandlers {
  /** `input` is the typed text, or the choice index as text for choice stops. */
  check(input: string): GateReveal;
  skip(): void;
  done(): void;
}

const PLACEHOLDER: Record<string, string> = {
  value: "Gõ giá trị Python, ví dụ 7, [1, 2], 'abc', True",
  line: "Gõ số dòng, ví dụ 12",
};

export class Gate {
  readonly el: HTMLElement;
  private handlers: GateHandlers | undefined;
  private current: StopCfg | undefined;
  private readonly head: HTMLElement;
  private readonly question: HTMLElement;
  private readonly body: HTMLElement;
  private readonly result: HTMLElement;
  private input: HTMLInputElement | undefined;
  private busy = false;

  constructor() {
    this.head = h("div", { class: "gate-head" });
    this.question = h("p", { class: "gate-q" });
    this.body = h("div", { class: "gate-body" });
    this.result = h("div", { class: "gate-result" });
    this.result.style.display = "none";
    this.el = h("section", { class: "gate", role: "dialog", "aria-label": "Dự đoán trước khi chạy" }, this.head, this.question, this.body, this.result);
    this.el.style.display = "none";
  }

  get isOpen(): boolean {
    return this.current !== undefined;
  }

  get stop(): StopCfg | undefined {
    return this.current;
  }

  show(stop: StopCfg, total: number, handlers: GateHandlers): void {
    this.current = stop;
    this.handlers = handlers;
    this.busy = false;
    this.head.textContent = "";
    this.head.appendChild(h("span", { class: "gate-badge", text: "Dự đoán" }));
    this.head.appendChild(h("span", { class: "gate-count", text: `Điểm dừng ${stop.k}/${total} · dòng ${stop.line}` }));
    this.question.textContent = "";
    for (const node of richText(stop.ask)) this.question.appendChild(node);
    this.body.textContent = "";
    this.result.style.display = "none";
    this.result.textContent = "";
    this.input = undefined;

    const skip = h("button", { class: "btn-ghost", type: "button", text: "Bỏ qua", title: "Bỏ qua câu hỏi này (tính là chưa đúng)" });
    skip.addEventListener("click", () => this.onSkip());

    this.el.classList.remove("has-result");
    if (stop.kind === "choice") {
      const list = h("div", { class: "gate-choices", role: "group" });
      (stop.choice ?? []).forEach((label, i) => {
        const b = h(
          "button",
          { class: "choice", type: "button" },
          h("span", { class: "choice-key mono", text: String.fromCharCode(65 + i) }),
          h("span", { class: "choice-text", text: label }),
        );
        b.addEventListener("click", () => this.onCheck(String(i)));
        list.appendChild(b);
      });
      this.body.appendChild(list);
      this.body.appendChild(h("div", { class: "gate-row" }, skip));
    } else {
      const input = h("input", {
        class: "gate-input mono",
        type: "text",
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        placeholder: PLACEHOLDER[stop.kind] ?? "",
        "aria-label": "Dự đoán của bạn",
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.onCheck(input.value);
        }
      });
      const check = h("button", { class: "btn-primary", type: "button", text: "Kiểm tra" });
      check.addEventListener("click", () => this.onCheck(input.value));
      this.input = input;
      this.body.appendChild(h("div", { class: "gate-row" }, input, check, skip));
    }
    this.el.style.display = "";
    this.el.classList.remove("in");
    void this.el.offsetWidth;
    this.el.classList.add("in");
    bringIntoView(this.el);
    queueMicrotask(() => this.input?.focus({ preventScroll: true }));
  }

  hide(): void {
    this.current = undefined;
    this.handlers = undefined;
    this.el.classList.remove("has-result");
    this.el.style.display = "none";
    this.body.textContent = "";
    this.result.textContent = "";
  }

  private onCheck(input: string): void {
    if (this.busy || !this.handlers || !this.current) return;
    if (this.current.kind !== "choice" && input.trim() === "") {
      this.input?.focus();
      return;
    }
    this.busy = true;
    const reveal = this.handlers.check(input);
    this.el.classList.add("has-result");
    this.body.style.display = "none";
    this.result.style.display = "";
    this.result.textContent = "";
    const right = reveal.right;
    this.result.appendChild(
      h(
        "div",
        { class: `gate-verdict ${right ? "right" : "diff"}`, role: "status" },
        icon(right ? "check" : "x", 20),
        h("span", { text: right ? "Đúng" : "Khác dự đoán" }),
      ),
    );
    const facts = h("div", { class: "gate-facts" });
    if (reveal.typed) {
      facts.appendChild(h("span", { class: "fact-k", text: "Bạn dự đoán" }));
      facts.appendChild(h("code", { class: "fact-v mono", text: reveal.typed }));
    }
    facts.appendChild(h("span", { class: "fact-k", text: "Thực tế" }));
    facts.appendChild(h("code", { class: "fact-v mono strong", text: reveal.actual }));
    this.result.appendChild(facts);
    if (reveal.explain) this.result.appendChild(h("p", { class: "gate-explain", text: reveal.explain }));
    const next = h("button", { class: "btn-primary", type: "button", text: "Tiếp tục" });
    next.addEventListener("click", () => this.onDone());
    this.result.appendChild(h("div", { class: "gate-row" }, next));
    bringIntoView(this.el);
    queueMicrotask(() => next.focus({ preventScroll: true }));
  }

  private onSkip(): void {
    if (this.busy || !this.handlers) return;
    this.busy = true;
    this.handlers.skip();
  }

  private onDone(): void {
    this.handlers?.done();
  }
}
