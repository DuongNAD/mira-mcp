/** Tiny DOM helpers: element factory, SVG factory, inline icons. No framework. */

const SVG_NS = "http://www.w3.org/2000/svg";

export type Child = Node | string | number | null | undefined | false;
export type Attrs = {
  class?: string;
  text?: string;
  html?: string;
  style?: Record<string, string>;
  [key: string]: unknown;
};

function applyAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const key of Object.keys(attrs)) {
    const val = attrs[key];
    if (val === undefined || val === null || val === false) continue;
    if (key === "class") el.setAttribute("class", String(val));
    else if (key === "text") el.textContent = String(val);
    else if (key === "html") el.innerHTML = String(val);
    else if (key === "style" && typeof val === "object") {
      const style = (el as HTMLElement).style;
      for (const prop of Object.keys(val as Record<string, string>)) style.setProperty(prop, (val as Record<string, string>)[prop] as string);
    } else if (key.startsWith("on") && typeof val === "function") {
      el.addEventListener(key.slice(2), val as EventListener);
    } else if (val === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(val));
  }
}

function appendKids(el: Element, kids: Child[]): void {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.appendChild(typeof kid === "object" ? kid : document.createTextNode(String(kid)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  appendKids(el, kids);
  return el;
}

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...kids: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  appendKids(el, kids);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Restarts a CSS animation class (flash) on an element. */
export function flash(el: Element, cls = "flash"): void {
  el.classList.remove(cls);
  // force a reflow so the animation restarts
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

const ICONS: Record<string, string> = {
  first: '<path d="M6 5v14"/><path d="M19 6l-8 6 8 6z" class="fill"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z" class="fill"/>',
  pause: '<path d="M8.5 5.5v13"/><path d="M15.5 5.5v13"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  last: '<path d="M18 5v14"/><path d="M5 6l8 6-8 6z" class="fill"/>',
  flag: '<path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  table: '<path d="M4 5h16v14H4z"/><path d="M4 10h16M10 5v14"/>',
};

export function icon(name: keyof typeof ICONS | string, size = 18): SVGSVGElement {
  const svg = s("svg", {
    class: `ico ico-${name}`,
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
  });
  svg.innerHTML = ICONS[name] ?? "";
  return svg;
}

export function isReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Splits `code` spans (backticks) in a question into DOM nodes. */
export function richText(text: string): Node[] {
  const out: Node[] = [];
  const parts = text.split("`");
  parts.forEach((part, i) => {
    if (part === "") return;
    out.push(i % 2 === 1 ? h("code", { class: "ic" }, part) : document.createTextNode(part));
  });
  return out;
}
