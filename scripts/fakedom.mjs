/**
 * A tiny fake DOM, just enough to execute the bundled Mira player under Node.
 * Used by scripts/e2e.mjs as a smoke test (no browser is available in CI): it proves the player boots, steps,
 * opens prediction gates, emits progress events, renders every viz kind and speaks the embed protocol.
 * It cannot judge visuals; layout is checked by hand in a real browser.
 */
import vm from "node:vm";

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.detail = 0;
    this.key = "";
    this.ctrlKey = false;
    this.metaKey = false;
    this.altKey = false;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {}
}

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n);
  }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.data = String(data);
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

class ClassList {
  constructor(el) {
    this.el = el;
  }
  _set() {
    return new Set((this.el.attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
  }
  _save(s) {
    this.el.attrs.set("class", [...s].join(" "));
  }
  add(...c) {
    const s = this._set();
    c.forEach((x) => s.add(x));
    this._save(s);
  }
  remove(...c) {
    const s = this._set();
    c.forEach((x) => s.delete(x));
    this._save(s);
  }
  toggle(c, force) {
    const s = this._set();
    const on = force === undefined ? !s.has(c) : Boolean(force);
    if (on) s.add(c);
    else s.delete(c);
    this._save(s);
    return on;
  }
  contains(c) {
    return this._set().has(c);
  }
}

function makeStyle() {
  const store = new Map();
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "setProperty") return (k, v) => store.set(String(k), String(v));
        if (prop === "getPropertyValue") return (k) => store.get(String(k)) ?? "";
        if (prop === "removeProperty") return (k) => store.delete(String(k));
        return store.get(String(prop)) ?? "";
      },
      set(_t, prop, v) {
        store.set(String(prop), String(v));
        return true;
      },
    },
  );
}

const stripTags = (s) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

function matchesSimple(el, sel) {
  // tag, .class, #id, tag.class, .a.b
  const m = /^([A-Za-z][A-Za-z0-9-]*)?((?:\.[\w-]+)*)(#[\w-]+)?$/.exec(sel.trim());
  if (!m) return false;
  if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  const classes = (m[2] ?? "").split(".").filter(Boolean);
  for (const c of classes) if (!el.classList.contains(c)) return false;
  if (m[3] && el.attrs.get("id") !== m[3].slice(1)) return false;
  return true;
}

export class FakeElement extends FakeNode {
  constructor(doc, tag, ns) {
    super(doc);
    this.nodeType = 1;
    this.tagName = ns ? tag : tag.toUpperCase();
    this.namespaceURI = ns ?? "http://www.w3.org/1999/xhtml";
    this.attrs = new Map();
    this.classList = new ClassList(this);
    this.style = makeStyle();
    this.listeners = new Map();
    this._html = "";
    this.scrollTop = 0;
    this.value = "";
    this.disabled = false;
    this.width = 0;
    this.height = 0;
  }
  get className() {
    return this.attrs.get("class") ?? "";
  }
  set className(v) {
    this.attrs.set("class", String(v));
  }
  get id() {
    return this.attrs.get("id") ?? "";
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k === "value") this.value = String(v);
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.childNodes.forEach((c) => (c.parentNode = null));
    this.childNodes = [];
    this._html = "";
    if (v !== "" && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(v));
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this.childNodes.forEach((c) => (c.parentNode = null));
    this.childNodes = [];
    this._html = String(v);
    const text = stripTags(this._html);
    if (text) this.appendChild(this.ownerDocument.createTextNode(text));
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get offsetTop() {
    return Math.max(0, (this.parentNode?.childNodes.indexOf(this) ?? 0)) * 20;
  }
  get offsetHeight() {
    return 20;
  }
  get offsetWidth() {
    return 100;
  }
  get clientHeight() {
    return 260;
  }
  get clientWidth() {
    return 640;
  }
  get scrollHeight() {
    return Math.max(260, this.childNodes.length * 20);
  }
  scrollTo(o) {
    this.scrollTop = typeof o === "object" ? o.top : Number(o);
  }
  addEventListener(type, fn) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type) ?? [];
    this.listeners.set(type, l.filter((x) => x !== fn));
  }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    let node = this;
    while (node) {
      ev.currentTarget = node;
      for (const fn of node.listeners?.get(ev.type) ?? []) fn(ev);
      node = node.parentNode && node.parentNode.dispatchEvent ? node.parentNode : null;
    }
    // document-level listeners (keydown etc.) are reached by bubbling to the document node
    return !ev.defaultPrevented;
  }
  click() {
    this.dispatchEvent(new FakeEvent("click", { detail: 0 }));
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  matches(sel) {
    return sel.split(",").some((s) => matchesSimple(this, s));
  }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) {
      if (n.matches(sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  getContext() {
    const noop = () => undefined;
    return new Proxy(
      {},
      {
        get: (_t, p) => (p === "measureText" ? () => ({ width: 10 }) : noop),
        set: () => true,
      },
    );
  }
}

export class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.documentElement = new FakeElement(this, "html");
    this.body = new FakeElement(this, "body");
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.hidden = false;
    this.focused = true;
    this.byId = new Map();
    this.nodeType = 9;
  }
  createElement(tag) {
    return new FakeElement(this, tag);
  }
  createElementNS(ns, tag) {
    return new FakeElement(this, tag, ns);
  }
  createTextNode(t) {
    return new FakeText(this, t);
  }
  getElementById(id) {
    if (this.byId.has(id)) return this.byId.get(id);
    return this.documentElement.querySelector(`#${id}`);
  }
  hasFocus() {
    return this.focused;
  }
  addEventListener(type, fn) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  fire(type, init = {}) {
    const ev = new FakeEvent(type, init);
    if (!ev.target) ev.target = this.activeElement;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return ev;
  }
}

export function extractPlayerParts(html) {
  const dataM = /<script type="application\/json" id="mira-data">([\s\S]*?)<\/script>/.exec(html);
  const jsM = /<\/script>\s*<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(html);
  if (!dataM || !jsM) throw new Error("player html: data or script block not found");
  return { dataText: dataM[1], js: jsM[1] };
}

/**
 * Boots the player bundle inside a vm context with the fake DOM and returns handles to drive it.
 * opts: { embed, protocol, search, hash, storageInit }
 */
export function bootPlayer(html, opts = {}) {
  const { dataText, js } = extractPlayerParts(html);
  const doc = new FakeDocument();
  const root = new FakeElement(doc, "div");
  root.attrs.set("id", "mira-root");
  doc.body.appendChild(root);
  const dataEl = new FakeElement(doc, "script");
  dataEl.attrs.set("id", "mira-data");
  dataEl.appendChild(doc.createTextNode(dataText));
  doc.byId.set("mira-root", root);
  doc.byId.set("mira-data", dataEl);

  const timers = [];
  let timerId = 0;
  const storage = new Map(Object.entries(opts.storageInit ?? {}));
  const messages = [];
  const fetchCalls = [];
  const winListeners = new Map();
  const parentWin = { postMessage: (m, origin) => messages.push({ m, origin }) };
  const sandbox = {
    document: doc,
    location: { protocol: opts.protocol ?? "file:", search: opts.search ?? "", hash: opts.hash ?? "", href: "" },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    navigator: { userAgent: "node-fake" },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (fn) => {
      timers.push({ id: ++timerId, fn: () => fn(0), ms: 16, raf: true });
      return timerId;
    },
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    setTimeout: (fn, ms) => {
      timers.push({ id: ++timerId, fn, ms: ms ?? 0 });
      return timerId;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    queueMicrotask: (fn) => fn(),
    fetch: (url, init) => {
      fetchCalls.push({ url, init });
      return Promise.resolve({ ok: true });
    },
    Blob: class {
      constructor(parts, o) {
        this.parts = parts;
        this.type = o?.type;
      }
    },
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
    console,
    devicePixelRatio: 1,
    innerWidth: 1366,
    innerHeight: 768,
    addEventListener: (type, fn) => {
      const l = winListeners.get(type) ?? [];
      l.push(fn);
      winListeners.set(type, l);
    },
    removeEventListener: () => {},
    postMessage: () => {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.parent = opts.embed ? parentWin : sandbox;
  const ctx = vm.createContext(sandbox);
  const errors = [];
  try {
    vm.runInContext(js, ctx, { filename: "mira-player.js" });
  } catch (e) {
    errors.push(e);
  }

  const all = (pred) => {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          if (pred(c)) out.push(c);
          walk(c);
        }
      }
    };
    walk(root);
    return out;
  };
  const api = {
    win: sandbox,
    doc,
    root,
    errors,
    timers,
    storage,
    messages,
    fetchCalls,
    winListeners,
    all,
    byClass: (c) => all((e) => e.classList.contains(c)),
    byAria: (sub) => all((e) => (e.getAttribute("aria-label") ?? "").includes(sub))[0] ?? null,
    click: (el, detail = 1) => el.dispatchEvent(new FakeEvent("click", { detail })),
    key: (key, init = {}) => doc.fire("keydown", { key, ...init }),
    text: (el) => el.textContent,
    runTimers(max = 50) {
      let n = 0;
      while (timers.length && n++ < max) {
        const t = timers.shift();
        t.fn();
      }
      return n;
    },
    dispatchWindow(type, init = {}) {
      const ev = new FakeEvent(type, init);
      for (const fn of winListeners.get(type) ?? []) fn(ev);
      return ev;
    },
    visible: (el) => el.style.display !== "none",
  };
  return api;
}
