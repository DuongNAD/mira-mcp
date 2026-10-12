/**
 * Protocol "mira-embed.v1": how a Mira player talks to the page that embeds it (Aurora `trace` slide, iframe).
 * Pure functions (no DOM types) so the message shapes and the embed detection are unit-tested in Node.
 *
 *   player -> parent  {source:"mira", v:1, kind:"ready", title, steps, stops}
 *                     {source:"mira", v:1, kind:"event", event:<aurora-progress-event.v1>}
 *                     {source:"mira", v:1, kind:"blur"}               (Escape: give the focus back to the deck)
 *   parent -> player  {source:"aurora", v:1, kind:"hello", theme:"dark"|"light", accent?:"#RRGGBB"}
 */

export const EMBED_PROTOCOL = "mira-embed.v1";

export interface WindowLike {
  parent: unknown;
  location: { search: string };
}

/** Embed mode is ON when the player runs inside a frame or the URL has ?embed=1. */
export function isEmbed(win: WindowLike): boolean {
  if (win.parent !== win) return true;
  return /(?:^|[?&])embed=1(?:&|$)/.test(win.location.search);
}

export interface ReadyMessage {
  source: "mira";
  v: 1;
  kind: "ready";
  title: string;
  steps: number;
  stops: number;
}
export interface EventMessage {
  source: "mira";
  v: 1;
  kind: "event";
  event: unknown;
}
export interface BlurMessage {
  source: "mira";
  v: 1;
  kind: "blur";
}
export type MiraMessage = ReadyMessage | EventMessage | BlurMessage;

export function readyMessage(info: { title: string; steps: number; stops: number }): ReadyMessage {
  return { source: "mira", v: 1, kind: "ready", title: info.title, steps: info.steps, stops: info.stops };
}

export function eventMessage(event: unknown): EventMessage {
  return { source: "mira", v: 1, kind: "event", event };
}

export function blurMessage(): BlurMessage {
  return { source: "mira", v: 1, kind: "blur" };
}

export interface Hello {
  theme?: "dark" | "light";
  accent?: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Validates a message from the parent; anything that is not a well-formed Aurora hello yields undefined. */
export function parseHello(data: unknown): Hello | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d.source !== "aurora" || d.v !== 1 || d.kind !== "hello") return undefined;
  const out: Hello = {};
  if (d.theme === "dark" || d.theme === "light") out.theme = d.theme;
  if (typeof d.accent === "string" && HEX.test(d.accent)) out.accent = d.accent.toUpperCase();
  return out;
}

export function hexToRgb(hex: string): [number, number, number] | undefined {
  if (!HEX.test(hex)) return undefined;
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

/** Posts a message to the parent frame; failures are ignored (the parent may not be listening). */
export function postToParent(win: { parent: { postMessage(message: unknown, targetOrigin: string): void } }, msg: MiraMessage): boolean {
  try {
    win.parent.postMessage(msg, "*");
    return true;
  } catch {
    return false;
  }
}
