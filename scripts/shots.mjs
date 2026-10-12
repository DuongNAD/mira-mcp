#!/usr/bin/env node
/**
 * Visual and responsive QA for the Mira player, in a real headless Chrome with real device emulation.
 *
 * Why this exists: `chrome --headless --window-size=390,844` is not a phone. Chrome on Windows enforces a minimum
 * window width (about 500 px), so such a screenshot shows a layout of roughly 490 px cropped to 390 px, which looks
 * like overflow but is not. Here every case uses `Emulation.setDeviceMetricsOverride` (width, height, scale 1, mobile
 * for widths < 768), so the layout viewport is exactly the requested size and `scrollWidth` vs `clientWidth` is
 * meaningful. Every case runs in its own browser context (file:// pages share one localStorage otherwise, which leaks
 * the saved theme from one case into the next).
 *
 * No npm packages: Chrome is driven over the DevTools protocol with Node's global WebSocket (Node >= 22.4).
 * Everything is written under %TEMP% (regenerated pages, screenshots, a throwaway Chrome profile). The only other
 * path touched is the learner's drill file, which is READ (Python runs with -B, so no __pycache__ is created).
 *
 *   node scripts/shots.mjs                    all cases on the demo pages (A*, Dijkstra, hub) and a real drill page
 *   node scripts/shots.mjs --fixtures         also pages that exercise graph, statevector, array, plot, table, stack...
 *   node scripts/shots.mjs --sweep            also sweep many viewport sizes (overflow only, no screenshots)
 *   node scripts/shots.mjs --only phone,embed only the cases/pages whose id contains one of the words
 *   node scripts/shots.mjs --reuse            keep the pages of the previous run instead of regenerating them
 *   node scripts/shots.mjs --out <dir>        output folder, must be inside %TEMP% (default %TEMP%/mira-shots)
 *   node scripts/shots.mjs --json             print the results as JSON
 *
 * Chrome: MIRA_CHROME, else the usual Chrome install paths, else Edge.
 * Exit code: 0 nothing wrong, 1 some case has an issue (overflow, clipped caption, ...), 2 Chrome or pages unavailable.
 *
 * Library use (scripts/e2e.mjs): `findChrome()`, `launchChrome()`, `measureCases(cases, { browser })`,
 * `scanCaptions(cases, { browser })`, `inspectCase(case, fn)`. A case is `{ page, file, id, w, h, query?, hash?,
 * theme?, prelude? }`; a row of results has `scrollWidth`, `clientWidth`, `overflow`, `offenders`, `issues`, `parts`.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "mira.mjs");
const DRILL_FILE = "D:/02_Learning_Knowledge/Python_Master/python-master-bang-b/luyen_tap/p1_doc_hieu.py";
const DRILL_FN = "tong_chu_so";
const SETTLE_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── cases ───────── */

/**
 * `player: true` cases only make sense for player pages (not for the demo hub).
 * `hash` opens a stop deep link; `prelude` then drives the page: "reveal" answers the gate, "stress" answers it, closes
 * it and fills the header with its widest content (score pill and toast), a number clicks that visualisation tab.
 */
export const CASES = [
  { id: "desktop-1366x768", w: 1366, h: 768 },
  { id: "desktop-1366x650", w: 1366, h: 650 },
  { id: "tablet-820x1180", w: 820, h: 1180 },
  { id: "land-844x390", w: 844, h: 390 },
  { id: "phone-430x932", w: 430, h: 932 },
  { id: "phone-390x844", w: 390, h: 844 },
  { id: "phone-360x740", w: 360, h: 740 },
  { id: "embed-1280x720", w: 1280, h: 720, query: "?embed=1", player: true },
  { id: "embed-960x540", w: 960, h: 540, query: "?embed=1", player: true },
  { id: "embed-390x844", w: 390, h: 844, query: "?embed=1", player: true },
  { id: "embed-360x640", w: 360, h: 640, query: "?embed=1", player: true },
  { id: "stop2-1366x768", w: 1366, h: 768, hash: "#stop-2", player: true },
  { id: "stop2-390x844", w: 390, h: 844, hash: "#stop-2", player: true },
  { id: "reveal-390x844", w: 390, h: 844, hash: "#stop-2", prelude: "reveal", player: true },
  { id: "stress-390x844", w: 390, h: 844, hash: "#stop-2", prelude: "stress", player: true },
  { id: "stress-360x740", w: 360, h: 740, hash: "#stop-2", prelude: "stress", player: true },
  // the player has a storage switch for the theme (localStorage "mira:theme"), no URL switch
  { id: "light-1366x768", w: 1366, h: 768, theme: "light", player: true },
  { id: "light-390x844", w: 390, h: 844, theme: "light", player: true },
];
const HUB_CASES = new Set(["desktop-1366x768", "tablet-820x1180", "phone-390x844", "phone-360x740"]);
const DIJKSTRA_CASES = new Set(["desktop-1366x768", "phone-390x844", "phone-360x740", "embed-960x540", "embed-390x844", "stop2-390x844", "light-390x844"]);
const FIXTURE_CASES = new Set(["desktop-1366x768", "phone-390x844", "phone-360x740", "embed-960x540"]);
/** visualisation tabs of each fixture page: every tab is shot */
const FIXTURE_TABS = { "viz-arrays": 3, "viz-quantum-graph": 3, "viz-stacks": 2 };

const SWEEP_WIDTHS = [320, 360, 375, 390, 412, 430, 480, 540, 600, 700, 760, 768, 820, 900, 1024, 1099, 1100, 1180, 1280, 1366, 1440, 1600, 1920];
const SWEEP_HEIGHTS = [390, 500, 640, 740, 900];
const SWEEP_EMBED = [
  [320, 568], [360, 640], [390, 844], [430, 932], [640, 360], [759, 600], [760, 540], [800, 450], [960, 540], [1099, 600], [1100, 620], [1280, 720], [1600, 900],
];

/* ───────── Chrome over the DevTools protocol ───────── */

export function findChrome() {
  if (process.env.MIRA_CHROME) return existsSync(process.env.MIRA_CHROME) ? process.env.MIRA_CHROME : undefined;
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          join(local, "Google", "Chrome", "Application", "chrome.exe"),
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((p) => existsSync(p));
}

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", () => res(), { once: true });
      this.ws.addEventListener("error", () => rej(new Error(`cannot connect to ${url}`)), { once: true });
    });
    this.ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    this.ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error(`connection closed during ${p.method}`));
      this.pending.clear();
    });
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
    } else if (msg.method && msg.sessionId) {
      this.sessions.get(msg.sessionId)?.(msg);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolveFn, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve: resolveFn, reject, timer, method });
      this.ws.send(JSON.stringify(payload));
    });
  }
}

/**
 * Starts a headless Chrome with a throwaway profile (never the user's profile or running session) and connects to it.
 * Always call `close()`.
 */
export async function launchChrome(chrome = findChrome()) {
  if (!chrome) throw new Error("Chrome not found (set MIRA_CHROME to chrome.exe or msedge.exe)");
  if (typeof WebSocket === "undefined") throw new Error("global WebSocket is missing: Node >= 22.4 is required");
  const profile = mkdtempSync(join(tmpdir(), "mira-chrome-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--window-size=1920,1200",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-8000);
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const killTree = () => {
    if (exited || !child.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  };
  const cleanup = () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      // best effort: a profile folder left in %TEMP% is harmless, a crash here is not
    }
  };

  // DevToolsActivePort: line 1 = chosen port, line 2 = browser websocket path
  let wsUrl;
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !wsUrl && !exited; i++) {
    try {
      if (existsSync(portFile)) {
        const [port, path] = readFileSync(portFile, "utf8").split(/\r?\n/);
        if (port && path) wsUrl = `ws://127.0.0.1:${port}${path}`;
      }
    } catch {
      // Windows answers EBUSY while Chrome is still writing the file: read it again on the next round
    }
    if (!wsUrl) wsUrl = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1];
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) {
    killTree();
    cleanup();
    throw new Error(`Chrome did not expose a DevTools endpoint${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`);
  }
  const cdp = new Cdp(wsUrl);
  try {
    await cdp.ready;
  } catch (e) {
    killTree();
    cleanup();
    throw e;
  }
  let version = "";
  try {
    version = (await cdp.send("Browser.getVersion")).product ?? "";
  } catch {
    // informational only
  }
  const close = async () => {
    try {
      await Promise.race([cdp.send("Browser.close"), sleep(2500)]);
    } catch {
      // the browser closes the socket while answering
    }
    for (let i = 0; i < 30 && !exited; i++) await sleep(100);
    killTree();
    await sleep(150);
    cleanup();
  };
  return { cdp, close, version, chrome };
}

/** A tab in its own browser context (own storage), downloads denied, page errors collected. */
async function newPage(cdp) {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  try {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId });
  } catch {
    // older builds: the page never clicks a download link in these checks anyway
  }
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  cdp.sessions.set(sessionId, (msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(`exception: ${d.exception?.description?.split("\n")[0] ?? d.text}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "assert")) {
      errors.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`.slice(0, 200));
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`.slice(0, 200));
    }
  });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  return {
    send,
    errors,
    evaluate: async (fn, ...args) => {
      const res = await send("Runtime.evaluate", { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(`page script failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
      return res.result.value;
    },
    close: async () => {
      cdp.sessions.delete(sessionId);
      await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
      await cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
    },
  };
}

async function waitLoaded(page) {
  for (let i = 0; i < 400; i++) {
    try {
      const res = await page.send("Runtime.evaluate", { expression: "document.readyState + '|' + location.protocol", returnByValue: true });
      if (res.result?.value === "complete|file:") return;
    } catch {
      // the execution context is replaced while the navigation commits
    }
    await sleep(50);
  }
  throw new Error("page did not finish loading");
}

/* ───────── in-page scripts (self-contained: serialised with toString()) ───────── */

function measureInPage() {
  return (async () => {
    try {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      // fonts are inlined; this only makes sure they are decoded
    }
    const de = document.documentElement;
    const vw = de.clientWidth;
    const TOL = 0.75;
    const describe = (el) => {
      const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
      return el.tagName.toLowerCase() + (cls ? `.${cls}` : "");
    };
    const clipsX = (cs) => cs.overflowX === "hidden" || cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflowX === "clip";
    const found = [];
    let clippedInside = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if (el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName.toLowerCase() !== "svg") continue; // scales with its svg root
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right <= vw + TOL && r.left >= -TOL) continue;
      // Is it clipped by an overflow container that sits inside the viewport (a scroller)? Then it is not page overflow.
      let clipped = false;
      if (cs.position !== "fixed") {
        let p = el.parentElement;
        let skipTo = cs.position === "absolute" ? el.offsetParent : null; // absolute boxes escape ancestors below their containing block
        while (p && p !== document.body && p !== de) {
          if (skipTo) {
            if (p === skipTo) skipTo = null;
            else {
              p = p.parentElement;
              continue;
            }
          }
          if (clipsX(getComputedStyle(p))) {
            const pr = p.getBoundingClientRect();
            if (pr.right <= vw + TOL && pr.left >= -TOL) {
              clipped = true;
              break;
            }
          }
          p = p.parentElement;
        }
      }
      if (clipped) {
        clippedInside++;
        continue;
      }
      found.push({ sel: describe(el), right: Math.round(r.right), left: Math.round(r.left), width: Math.round(r.width) });
    }
    found.sort((a, b) => b.right - a.right);
    const offenders = [];
    const seen = new Set();
    for (const f of found) {
      const key = `${f.sel}|${f.right}`;
      if (seen.has(key)) continue;
      seen.add(key);
      offenders.push(f);
      if (offenders.length >= 10) break;
    }
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height), width: Math.round(r.width) };
    };
    const parts = {};
    for (const [name, sel] of [
      ["top", ".top"],
      ["counters", ".counters"],
      ["viz", ".viz"],
      ["code", ".code"],
      ["caption", ".caption"],
      ["vars", ".vars"],
      ["out", ".out"],
      ["controls", ".controls"],
      ["gate", ".gate"],
    ]) {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === "none") continue;
      parts[name] = rect(el);
    }
    const codeEl = document.querySelector(".code-scroll");
    const canvas = document.querySelector(".grid-canvas");
    const wrap = document.querySelector(".grid-wrap");
    const svgs = [...document.querySelectorAll(".graph-svg, .plot-svg, .heap-tree")].filter((s) => getComputedStyle(s).display !== "none");
    const cap = document.querySelector(".caption");
    const h1 = document.querySelector(".titles h1");
    const tabs = document.querySelector(".tabs");
    const issues = [];
    // a caption line is "cut" when a visible line of it sticks out of the box (a hint line moved into the hidden
    // wrap column on purpose is not visible and not counted)
    if (cap) {
      const cr = cap.getBoundingClientRect();
      const ccs = getComputedStyle(cap);
      const floor = cr.bottom - parseFloat(ccs.borderBottomWidth);
      const edge = cr.right - parseFloat(ccs.borderRightWidth);
      for (const [name, el] of [["narration", cap.querySelector(".cap-main")], ["hint line", cap.querySelector(".cap-sub")]]) {
        if (!el || !el.textContent || getComputedStyle(el).display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.left < edge - 1 && r.bottom > floor + 0.5) issues.push(`caption ${name} cut (${Math.round(r.bottom)}>${Math.round(floor)})`);
      }
    }
    if (h1 && h1.getBoundingClientRect().width < 90 && h1.textContent.length > 8) issues.push(`title crushed (${Math.round(h1.getBoundingClientRect().width)}px)`);
    for (const s of svgs) if (s.getBoundingClientRect().right > vw + TOL) issues.push(`${describe(s)} wider than the viewport`);
    if (canvas && wrap && getComputedStyle(canvas).display !== "none" && canvas.getBoundingClientRect().width > wrap.clientWidth + 1) issues.push("grid canvas wider than its container");
    return {
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      scrollHeight: de.scrollHeight,
      clientHeight: de.clientHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      offenders,
      clippedInside,
      parts,
      issues,
      codeScroll: codeEl ? { scrollWidth: codeEl.scrollWidth, clientWidth: codeEl.clientWidth } : null,
      tabsScroll: tabs ? { scrollWidth: tabs.scrollWidth, clientWidth: tabs.clientWidth } : null,
      gridFit: canvas && wrap ? { canvas: Math.round(canvas.getBoundingClientRect().width), wrap: wrap.clientWidth } : null,
      svgFit: svgs.map((s) => ({ sel: describe(s), width: Math.round(s.getBoundingClientRect().width), height: Math.round(s.getBoundingClientRect().height) })),
      isPlayer: Boolean(document.querySelector(".app")),
      embed: document.querySelector(".app")?.getAttribute("data-embed") === "1",
      theme: de.getAttribute("data-theme"),
    };
  })();
}

/** Drives the page into a state worth a screenshot. */
async function preludeInPage(kind) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  const answer = async () => {
    const choice = document.querySelector(".gate .choice");
    const input = document.querySelector(".gate-input");
    if (choice) choice.click();
    else if (input) {
      input.value = "0";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    } else return false;
    await wait(200);
    return true;
  };
  if (kind === "reveal") return answer();
  if (kind === "stress") {
    const ok = await answer();
    byText("Tiếp tục")?.click();
    await wait(200);
    const toast = document.querySelector(".toast");
    if (toast) {
      toast.textContent = "Đã xuất 120 sự kiện";
      toast.classList.add("on");
    }
    return ok;
  }
  if (typeof kind === "number") {
    const tabs = document.querySelectorAll(".tab");
    tabs[kind]?.click();
    await wait(150);
    return tabs.length;
  }
  return false;
}

/**
 * Steps through every step with the scrubber and reports captions whose visible text sticks out of the caption box
 * (`clipped`), and narrations that the line clamp shortens with an ellipsis (`truncated`, informational: by design
 * in the fixed-height layouts, which show at most two lines).
 */
function scanCaptionsInPage() {
  const range = document.querySelector(".scrub-range");
  const cap = document.querySelector(".caption");
  const main = cap?.querySelector(".cap-main");
  const sub = cap?.querySelector(".cap-sub");
  if (!range || !cap || !main || !sub) return { steps: 0, clipped: 0, truncated: 0, samples: [] };
  const n = Number(range.max) + 1;
  const seen = new Set();
  const samples = [];
  let clipped = 0;
  let truncated = 0;
  for (let k = 0; k < n; k++) {
    range.value = String(k);
    range.dispatchEvent(new Event("input", { bubbles: true }));
    const cr = cap.getBoundingClientRect();
    const ccs = getComputedStyle(cap);
    const floor = cr.bottom - parseFloat(ccs.borderBottomWidth);
    const edge = cr.right - parseFloat(ccs.borderRightWidth);
    const cut = [];
    for (const [name, el] of [["narration", main], ["hint line", sub]]) {
      if (!el.textContent || getComputedStyle(el).display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.left < edge - 1 && r.bottom > floor + 0.5) cut.push(`${name} ${Math.round(r.bottom)}>${Math.round(floor)}`);
    }
    if (main.scrollHeight > main.clientHeight + 1) truncated++;
    if (cut.length) {
      clipped++;
      const key = `${main.textContent}|${sub.textContent}`;
      if (!seen.has(key) && samples.length < 5) {
        seen.add(key);
        samples.push({ step: k + 1, main: main.textContent.slice(0, 90), sub: sub.textContent.slice(0, 40), box: cut.join(", ") });
      }
    }
  }
  return { steps: n, clipped, truncated, samples };
}

/* ───────── running cases ───────── */

function caseUrl(c) {
  return `${pathToFileURL(c.file).href}${c.query ?? ""}${c.hash ?? ""}`;
}

/** True when the layout is meant to fit the viewport without page scroll (side-by-side shell, not the stacked one). */
function fixedShell(c, m) {
  if (!m.isPlayer) return false; // the demo hub is an ordinary scrolling page
  if (m.embed) return c.w >= 760;
  return c.w >= 1100 && c.h >= 560; // .app has min-height: 560px
}

async function openCase(page, c) {
  const mobile = c.w < 768;
  await page.send("Emulation.setDeviceMetricsOverride", { width: c.w, height: c.h, deviceScaleFactor: 1, mobile, screenWidth: c.w, screenHeight: c.h });
  if (mobile) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  if (c.theme) {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("mira:theme",${JSON.stringify(c.theme)})}catch(e){}` });
  }
  await page.send("Page.navigate", { url: caseUrl(c) });
  await waitLoaded(page);
  await sleep(SETTLE_MS);
  if (c.prelude !== undefined) {
    await page.evaluate(preludeInPage, c.prelude);
    await sleep(350);
  }
}

async function runCase(cdp, c, { shotDir, full }) {
  const page = await newPage(cdp);
  try {
    await openCase(page, c);
    const m = await page.evaluate(measureInPage);
    const row = {
      page: c.page ?? "page",
      id: c.id,
      w: c.w,
      h: c.h,
      ...m,
      overflow: m.scrollWidth > m.clientWidth || m.offenders.length > 0,
      fixedShell: fixedShell(c, m),
      errors: [...page.errors],
    };
    row.vScroll = row.fixedShell && m.scrollHeight > m.clientHeight + 1;
    row.problems = [...(row.overflow ? ["h-overflow"] : []), ...(row.vScroll ? ["page scrolls vertically"] : []), ...m.issues];
    if (shotDir) {
      const base = `${(c.page ?? "page").replace(/[^\w-]+/g, "_")}__${c.id}`;
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      row.png = join(shotDir, `${base}.png`);
      writeFileSync(row.png, Buffer.from(shot.data, "base64"));
      if (full && !row.fixedShell && m.scrollHeight > m.clientHeight + 4) {
        const lm = await page.send("Page.getLayoutMetrics");
        const size = lm.cssContentSize ?? lm.contentSize;
        const height = Math.min(Math.ceil(size.height), 7000);
        const fullShot = await page.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: c.w, height, scale: 1 },
        });
        row.pngFull = join(shotDir, `${base}__full.png`);
        writeFileSync(row.pngFull, Buffer.from(fullShot.data, "base64"));
      }
    }
    return row;
  } finally {
    await page.close();
  }
}

/**
 * Measures cases `{ page, file, id, w, h, query?, hash?, theme?, prelude? }` in one headless Chrome.
 * With `shotDir` it also saves PNGs (plus a full-height one for stacked layouts).
 */
export async function measureCases(cases, { shotDir, full = true, onRow, browser: shared } = {}) {
  const browser = shared ?? (await launchChrome());
  const rows = [];
  try {
    if (shotDir) mkdirSync(shotDir, { recursive: true });
    for (const c of cases) {
      const row = await runCase(browser.cdp, c, { shotDir, full });
      rows.push(row);
      onRow?.(row);
    }
  } finally {
    if (!shared) await browser.close();
  }
  return { rows, chrome: browser.version };
}

/**
 * Walks all steps of a page at one viewport size and returns how many captions clip their text.
 * Pass `browser` (from launchChrome) to reuse one Chrome for several calls; the caller then closes it.
 */
export async function scanCaptions(cases, { browser: shared } = {}) {
  const browser = shared ?? (await launchChrome());
  const out = [];
  try {
    for (const c of cases) {
      const page = await newPage(browser.cdp);
      try {
        await openCase(page, c);
        out.push({ page: c.page ?? "page", id: c.id, ...(await page.evaluate(scanCaptionsInPage)) });
      } finally {
        await page.close();
      }
    }
  } finally {
    if (!shared) await browser.close();
  }
  return out;
}

/** Opens one case and returns whatever the self-contained function `fn` computes in the page (ad hoc debugging). */
export async function inspectCase(c, fn, ...args) {
  const browser = await launchChrome();
  try {
    const page = await newPage(browser.cdp);
    try {
      await openCase(page, c);
      return await page.evaluate(fn, ...args);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * Resizes one loaded page through many viewport sizes and reports problems only (fast, no screenshots).
 * `embed`: the ?embed=1 layout; `stress`: first answer the gate of stop 2 so the header carries its widest content.
 */
async function sweepPage(cdp, name, file, { embed = false, stress = false }) {
  const sizes = embed ? SWEEP_EMBED : SWEEP_HEIGHTS.flatMap((h) => SWEEP_WIDTHS.map((w) => [w, h]));
  const groups = [sizes.filter(([w]) => w < 768), sizes.filter(([w]) => w >= 768)];
  const failures = [];
  let checked = 0;
  for (const group of groups) {
    if (group.length === 0) continue;
    const page = await newPage(cdp);
    try {
      const [w0, h0] = group[0];
      await openCase(page, { file, w: w0, h: h0, query: embed ? "?embed=1" : "", ...(stress ? { hash: "#stop-2", prelude: "stress" } : {}) });
      for (const [w, h] of group) {
        await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768, screenWidth: w, screenHeight: h });
        await sleep(160);
        const m = await page.evaluate(measureInPage);
        checked++;
        const shell = fixedShell({ w, h }, m);
        const vOver = shell && m.scrollHeight > m.clientHeight + 1;
        const hOver = m.scrollWidth > m.clientWidth || m.offenders.length > 0;
        if (hOver || vOver || m.issues.length) {
          failures.push({
            page: name,
            embed,
            stress,
            w,
            h,
            scrollWidth: m.scrollWidth,
            clientWidth: m.clientWidth,
            vOver,
            scrollHeight: m.scrollHeight,
            clientHeight: m.clientHeight,
            issues: m.issues,
            offenders: m.offenders.slice(0, 3).map((o) => `${o.sel}@${o.right}`),
          });
        }
      }
    } finally {
      await page.close();
    }
  }
  return { checked, failures };
}

/* ───────── pages ───────── */

const SHAPES_PY = `import heapq
from collections import deque


def data_shapes():
    # generic toy data (not an exercise): enough shapes to exercise every visualisation kind in the player
    arr = [5, 3, 8, 1, 9, 2, 7, 4, 6, 0, 12, 15, 11, 14]
    i = 0
    losses = []
    for step in range(8):
        losses.append(10 / (step + 1))
        i = step
    table = {"a": 1, "b": 2, "ten_dai": "một chuỗi khá dài để kiểm tra việc cắt chữ trong ô của bảng"}
    state = [0.5 + 0j, 0.5 + 0j, 0j, 0.5 + 0j, 0j, 0j, 0.5 + 0j, 0j]
    graph = {0: [1, 2], 1: [0, 3], 2: [0, 3], 3: [1, 2, 4], 4: [3, 5], 5: [4]}
    seen = set()
    for node in [0, 1, 2, 3]:
        seen.add(node)
    stack = [1]
    stack.append(2)
    queue = deque([1])
    queue.append(2)
    heap = []
    for v in (5, 3, 8, 1, 9, 2, 7):
        heapq.heappush(heap, v)
    return len(arr)
`;

function runMira(args) {
  return execFileSync(process.execPath, [DIST, ...args], {
    encoding: "utf8",
    env: { ...process.env, MIRA_SMARTDRIVE: "off" },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function staleWarning() {
  try {
    const built = statSync(DIST).mtimeMs;
    const watch = ["src/player/player.css", "src/player/main.ts", "src/player/ui/controls.ts", "src/player/ui/panels.ts", "src/player/ui/gate.ts", "src/player/viz/grid.ts", "src/player/viz/graph.ts", "src/demo.ts", "src/drill.ts", "src/build.ts"];
    const newer = watch.filter((f) => existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).mtimeMs > built + 1000);
    return newer.length ? `dist/mira.mjs is older than ${newer.join(", ")}: run node scripts/build.mjs first` : "";
  } catch {
    return "";
  }
}

/** Regenerates every input page under `pagesDir`. Returns { name: absolute html path } and notes. */
async function generatePages(pagesDir, { fixtures }) {
  rmSync(pagesDir, { recursive: true, force: true });
  mkdirSync(pagesDir, { recursive: true });
  const pages = {};
  const notes = [];
  const demoDir = join(pagesDir, "demo");
  runMira(["demo", demoDir]);
  pages.astar = join(demoDir, "astar", "index.html");
  pages.dijkstra = join(demoDir, "dijkstra", "index.html");
  pages.hub = join(demoDir, "index.html");

  if (existsSync(DRILL_FILE)) {
    const drillDir = join(pagesDir, "drill");
    // `--out` is the real flag (there is no --out-dir); the source file is only read
    runMira(["drill", DRILL_FILE, DRILL_FN, "--out", drillDir]);
    pages.drill = join(drillDir, "index.html");
  } else {
    notes.push(`drill page skipped: ${DRILL_FILE} not found`);
  }

  if (fixtures) {
    const lib = await import(pathToFileURL(DIST).href);
    const fx = join(pagesDir, "fx");
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, "shapes.py"), SHAPES_PY, "utf8");
    const rec = await lib.recordTrace({ file: join(fx, "shapes.py"), call: "data_shapes()", out_dir: join(fx, "trace") });
    if (!rec.ok) {
      notes.push(`viz fixtures skipped: ${String(rec.text ?? "record failed").split("\n")[0]}`);
    } else {
      const lastLine = rec.trace.steps.filter((s) => s.ev === "line").pop().line;
      const loopLine = SHAPES_PY.split("\n").findIndex((l) => l.includes("losses.append")) + 1;
      const stepCount = rec.trace.steps.filter((s) => s.ev !== "call").length;
      const sets = [
        ["arrays", [{ kind: "array", var: "arr", pointers: ["i"] }, { kind: "table", var: "table" }, { kind: "plot", var: "losses", y_label: "mất mát" }]],
        ["quantum-graph", [{ kind: "statevector", var: "state" }, { kind: "graph", adjacency: "graph", visited: "seen" }, { kind: "heap", var: "heap" }]],
        ["stacks", [{ kind: "stack", var: "stack" }, { kind: "queue", var: "queue" }]],
      ];
      for (const [label, viz] of sets) {
        const b = await lib.buildPlayer({
          title: `Hình dạng dữ liệu: ${label}`,
          trace: join(fx, "trace", "trace.json"),
          out_dir: join(pagesDir, `viz-${label}`),
          viz,
          start_step: Math.max(0, stepCount - 2), // after every variable is assigned, so no viz shows its empty state
          counters: [
            { label: "Vòng lặp", expr: "step" },
            { label: "Phần tử", expr: "len(arr)" },
            { label: "Lần chạy dòng lặp", line_hits: loopLine },
          ],
          stops: [
            { at: { line: loopLine, hit: 3 }, ask: "Khi dòng này sắp chạy lần thứ 3, `step` bằng bao nhiêu?", expect: { expr: "step" } },
            { at: { line: lastLine }, ask: "Hàm trả về?", expect: { expr: "return" } },
          ],
        });
        if (b.ok) pages[`viz-${label}`] = b.indexPath;
        else notes.push(`viz fixture ${label} skipped: ${b.errors.join("; ").slice(0, 160)}`);
      }
    }
  }
  return { pages, notes };
}

function existingPages(pagesDir) {
  const pages = {};
  const probe = {
    astar: join(pagesDir, "demo", "astar", "index.html"),
    dijkstra: join(pagesDir, "demo", "dijkstra", "index.html"),
    hub: join(pagesDir, "demo", "index.html"),
    drill: join(pagesDir, "drill", "index.html"),
    "viz-arrays": join(pagesDir, "viz-arrays", "index.html"),
    "viz-quantum-graph": join(pagesDir, "viz-quantum-graph", "index.html"),
    "viz-stacks": join(pagesDir, "viz-stacks", "index.html"),
  };
  for (const [k, p] of Object.entries(probe)) if (existsSync(p)) pages[k] = p;
  return pages;
}

function planCases(pages, only) {
  const cases = [];
  for (const [name, file] of Object.entries(pages)) {
    const fixture = name.startsWith("viz-");
    for (const c of CASES) {
      if (name === "hub" && (c.player || !HUB_CASES.has(c.id))) continue;
      if (name === "dijkstra" && !DIJKSTRA_CASES.has(c.id)) continue;
      if (fixture && (!FIXTURE_CASES.has(c.id) || c.hash || c.theme)) continue;
      if (only.length && !only.some((t) => c.id.includes(t) || name.includes(t))) continue;
      if (fixture) {
        for (let t = 0; t < (FIXTURE_TABS[name] ?? 1); t++) cases.push({ ...c, id: `${c.id}-tab${t + 1}`, prelude: t, page: name, file });
      } else {
        cases.push({ ...c, page: name, file });
      }
    }
  }
  return cases;
}

/* ───────── output ───────── */

function offenderText(row, max = 3) {
  const list = row.offenders.slice(0, max).map((o) => `${o.sel}@${o.right}`);
  const more = row.offenders.length > max ? ` +${row.offenders.length - max}` : "";
  return list.length ? list.join(", ") + more : "-";
}

function printTable(rows) {
  const head = ["page", "case", "scrollW", "clientW", "overflow", "scrollH/clientH", "vscroll", "offenders", "other problems"];
  const body = rows.map((r) => [
    r.page,
    r.id,
    String(r.scrollWidth),
    String(r.clientWidth),
    r.overflow ? "YES" : "no",
    `${r.scrollHeight}/${r.clientHeight}`,
    r.fixedShell ? (r.vScroll ? "YES" : "no") : "(stacked)",
    offenderText(r),
    r.issues.length ? r.issues.join("; ") : "-",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  let last = "";
  for (const [i, b] of body.entries()) {
    if (last && rows[i].page !== last) console.log("");
    last = rows[i].page;
    console.log(line(b));
  }
}

function printDetails(rows) {
  const bad = rows.filter((r) => r.overflow);
  if (bad.length) {
    console.log("\nOverflow details (element, right/left edge and width in px; viewport width in brackets):");
    for (const r of bad) {
      console.log(`  ${r.page} / ${r.id} [${r.clientWidth}]`);
      for (const o of r.offenders) console.log(`    ${o.sel.padEnd(34)} right ${String(o.right).padStart(5)}  left ${String(o.left).padStart(5)}  width ${o.width}`);
      if (r.offenders.length === 0) console.log("    (scrollWidth exceeds clientWidth but no single element sticks out: check negative margins and transforms)");
    }
  }
  const errs = rows.filter((r) => r.errors.length);
  if (errs.length) {
    console.log("\nPage errors:");
    for (const r of errs) for (const e of [...new Set(r.errors)].slice(0, 3)) console.log(`  ${r.page} / ${r.id}: ${e}`);
  }
}

function parseCli(argv) {
  const o = { out: join(tmpdir(), "mira-shots"), only: [], reuse: false, sweep: false, fixtures: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = resolve(argv[++i] ?? "");
    else if (a === "--only") o.only = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--reuse") o.reuse = true;
    else if (a === "--sweep") o.sweep = true;
    else if (a === "--fixtures") o.fixtures = true;
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

async function main() {
  const o = parseCli(process.argv.slice(2));
  if (o.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, "").replace(/^\/\*\*?\n?/, "").replace(/^ \* ?/gm, ""));
    return 0;
  }
  const tmpRoot = resolve(tmpdir()).toLowerCase() + sep;
  if (!(resolve(o.out).toLowerCase() + sep).startsWith(tmpRoot)) throw new Error(`--out must be inside ${tmpdir()} (nothing is written elsewhere)`);
  if (!existsSync(DIST)) throw new Error("dist/mira.mjs not found: run node scripts/build.mjs first");
  const chrome = findChrome();
  if (!chrome) {
    console.error("Chrome not found: set MIRA_CHROME to chrome.exe or msedge.exe");
    return 2;
  }
  const stale = staleWarning();
  if (stale) console.error(`warning: ${stale}`);

  const pagesDir = join(o.out, "pages");
  const pngDir = join(o.out, "png");
  mkdirSync(o.out, { recursive: true });
  let pages;
  let notes = [];
  if (o.reuse && existsSync(join(pagesDir, "demo", "astar", "index.html"))) {
    pages = existingPages(pagesDir);
  } else {
    process.stderr.write(`regenerating pages under ${pagesDir} ...\n`);
    ({ pages, notes } = await generatePages(pagesDir, { fixtures: o.fixtures }));
  }
  for (const n of notes) console.error(`note: ${n}`);
  rmSync(pngDir, { recursive: true, force: true });
  mkdirSync(pngDir, { recursive: true });

  const cases = planCases(pages, o.only);
  const started = Date.now();
  const { rows, chrome: version } = await measureCases(cases, {
    shotDir: pngDir,
    onRow: (r) => process.stderr.write(r.problems.length ? "!" : "."),
  });
  process.stderr.write("\n");
  // keep the measurements even if a later phase (caption scan, sweep) dies
  writeFileSync(join(o.out, "results.json"), JSON.stringify({ chrome: version, out: o.out, partial: true, rows }, null, 2), "utf8");

  // every caption of every step must fit its box, on a phone, a tablet and a desktop
  const scanTargets = ["astar", "drill"].filter((n) => pages[n] && (!o.only.length || o.only.some((t) => n.includes(t) || "caption".includes(t))));
  const captionScan = scanTargets.length
    ? await scanCaptions(
        scanTargets.flatMap((p) => [
          { page: p, file: pages[p], id: "desktop-1366x768", w: 1366, h: 768 },
          { page: p, file: pages[p], id: "phone-390x844", w: 390, h: 844 },
          { page: p, file: pages[p], id: "phone-360x740", w: 360, h: 740 },
          { page: p, file: pages[p], id: "embed-960x540", w: 960, h: 540, query: "?embed=1" },
        ]),
      )
    : [];

  let sweep;
  if (o.sweep) {
    const browser = await launchChrome();
    try {
      sweep = { checked: 0, failures: [] };
      const names = Object.keys(pages).filter((n) => n !== "hub" && (!o.only.length || o.only.some((t) => n.includes(t))));
      for (const name of names) {
        for (const mode of [{}, { stress: true }, { embed: true }]) {
          const r = await sweepPage(browser.cdp, name, pages[name], mode);
          sweep.checked += r.checked;
          sweep.failures.push(...r.failures);
          process.stderr.write(r.failures.length ? "!" : ".");
        }
      }
      if (pages.hub && (!o.only.length || o.only.some((t) => "hub".includes(t)))) {
        const r = await sweepPage(browser.cdp, "hub", pages.hub, { embed: false });
        sweep.checked += r.checked;
        sweep.failures.push(...r.failures);
      }
      process.stderr.write("\n");
    } finally {
      await browser.close();
    }
  }

  const summary = { chrome: version, out: o.out, seconds: Math.round((Date.now() - started) / 100) / 10, rows, captionScan, sweep };
  writeFileSync(join(o.out, "results.json"), JSON.stringify(summary, null, 2), "utf8");
  if (o.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Chrome ${version || chrome}, ${rows.length} cases in ${summary.seconds}s, output ${o.out}\n`);
    printTable(rows);
    printDetails(rows);
    if (captionScan.length) {
      console.log("\nCaption scan (every step, caption box must not clip its text):");
      for (const s of captionScan) {
        console.log(`  ${s.page.padEnd(8)} ${s.id.padEnd(18)} ${s.steps} steps, ${s.clipped} clipped, ${s.truncated} shortened by the line clamp${s.samples.length ? `; e.g. step ${s.samples[0].step} "${s.samples[0].main}" [${s.samples[0].box}]` : ""}`);
      }
    }
    const shotsOf = (page, id) => rows.find((r) => r.page === page && r.id === id)?.png;
    console.log("\nKey screenshots:");
    for (const [page, id] of [["astar", "desktop-1366x768"], ["astar", "phone-390x844"], ["astar", "embed-960x540"], ["drill", "stop2-390x844"]]) {
      const p = shotsOf(page, id);
      if (p) console.log(`  ${page} ${id}: ${p}`);
    }
    if (sweep) {
      console.log(`\nSweep: ${sweep.checked} viewport sizes checked, ${sweep.failures.length} with a problem`);
      for (const f of sweep.failures.slice(0, 40)) {
        const what = [f.scrollWidth > f.clientWidth ? `scrollW ${f.scrollWidth}/${f.clientWidth}` : "", f.vOver ? `page scroll ${f.scrollHeight}/${f.clientHeight}` : "", ...f.issues, f.offenders.join(", ")].filter(Boolean).join("; ");
        console.log(`  ${f.page}${f.embed ? " (embed)" : f.stress ? " (stress)" : ""} ${f.w}x${f.h}: ${what}`);
      }
      if (sweep.failures.length > 40) console.log(`  ... ${sweep.failures.length - 40} more (see results.json)`);
    }
  }
  const bad = rows.filter((r) => r.problems.length).length;
  const clippedCaps = captionScan.reduce((n, s) => n + s.clipped, 0);
  const sweepBad = sweep ? sweep.failures.length : 0;
  if (!o.json) {
    console.log(
      `\nResult: ${rows.filter((r) => r.overflow).length} of ${rows.length} cases overflow horizontally, ${bad} have any problem, ${clippedCaps} clipped captions${sweep ? `, ${sweepBad} sweep failures` : ""}`,
    );
  }
  return bad > 0 || clippedCaps > 0 || sweepBad > 0 ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
