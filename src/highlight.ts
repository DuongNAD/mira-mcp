/**
 * Small Python tokenizer -> per-line HTML spans. No external highlighter.
 * Classes: k keyword, b builtin, s string, n number, c comment, d def/class name, o operator, a decorator.
 */
import { esc } from "./util.js";

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const BUILTINS = new Set([
  "abs", "all", "any", "bin", "bool", "bytes", "callable", "chr", "complex", "dict", "divmod", "enumerate", "filter",
  "float", "format", "frozenset", "getattr", "hasattr", "hash", "hex", "id", "input", "int", "isinstance", "issubclass",
  "iter", "len", "list", "map", "max", "min", "next", "object", "oct", "open", "ord", "pow", "print", "range", "repr",
  "reversed", "round", "set", "setattr", "slice", "sorted", "str", "sum", "super", "tuple", "type", "vars", "zip",
  "self", "cls", "ValueError", "TypeError", "KeyError", "IndexError", "ZeroDivisionError", "StopIteration",
  "RuntimeError", "NameError", "AttributeError", "AssertionError", "ImportError", "OSError", "Exception",
  "NotImplementedError", "OverflowError", "RecursionError",
]);

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)/;
const IDENT = /^[\p{L}_][\p{L}\p{N}_]*/u;
const OPERATOR = /^(?:->|:=|\*\*=?|\/\/=?|<<=?|>>=?|==|!=|[+\-*/%<>=!&|^~@]=?)/;

export interface Highlighted {
  /** HTML per source line */
  html: string[];
  /** inString[i] is true when line i (0-based) starts inside a multi-line string literal */
  inString: boolean[];
}

export function highlightSource(source: string[]): Highlighted {
  const text = source.join("\n");
  const pieces: string[][] = source.map(() => []);
  const inString: boolean[] = source.map(() => false);
  let line = 0;
  let atLineStart = true; // only whitespace seen on this logical line so far
  let prevWord = "";

  const emit = (cls: string | undefined, s: string, isString = false): void => {
    const parts = s.split("\n");
    for (let idx = 0; idx < parts.length; idx++) {
      if (idx > 0) {
        line++;
        if (isString && line < inString.length) inString[line] = true;
      }
      const p = parts[idx] as string;
      if (p === "") continue;
      const html = esc(p);
      pieces[line]?.push(cls ? `<span class="${cls}">${html}</span>` : html);
    }
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const rest = text.slice(i, i + 200);
    const ch = text[i] as string;

    if (ch === "\n") {
      emit(undefined, "\n");
      i++;
      atLineStart = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      let j = i;
      while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j++;
      emit(undefined, text.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "#") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      emit("c", text.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "@" && atLineStart) {
      const m = /^@[\p{L}_][\p{L}\p{N}_.]*/u.exec(rest);
      if (m) {
        emit("a", m[0]);
        i += m[0].length;
        atLineStart = false;
        continue;
      }
    }
    // string literal, with optional prefix
    const sm = /^(?:[rRbBuUfF]{1,2})?(?='|")/.exec(rest);
    if (sm) {
      const prefixLen = sm[0].length;
      const q = text[i + prefixLen] as string;
      const triple = text.startsWith(q.repeat(3), i + prefixLen);
      let j = i + prefixLen + (triple ? 3 : 1);
      for (;;) {
        if (j >= n) break;
        const c = text[j] as string;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (triple) {
          if (text.startsWith(q.repeat(3), j)) {
            j += 3;
            break;
          }
        } else {
          if (c === q) {
            j++;
            break;
          }
          if (c === "\n") break; // unterminated single-line string: stop at the newline
        }
        j++;
      }
      emit("s", text.slice(i, Math.min(j, n)), true);
      i = Math.min(j, n);
      atLineStart = false;
      prevWord = "";
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const m = NUMBER.exec(rest);
      if (m && m[0].length > 0) {
        emit("n", m[0]);
        i += m[0].length;
        atLineStart = false;
        prevWord = "";
        continue;
      }
    }
    const im = IDENT.exec(rest);
    if (im) {
      const w = im[0];
      let cls: string | undefined;
      if (prevWord === "def" || prevWord === "class") cls = "d";
      else if (KEYWORDS.has(w)) cls = "k";
      else if (BUILTINS.has(w)) cls = "b";
      emit(cls, w);
      i += w.length;
      atLineStart = false;
      prevWord = w;
      continue;
    }
    const om = OPERATOR.exec(rest);
    if (om) {
      emit("o", om[0]);
      i += om[0].length;
      atLineStart = false;
      prevWord = "";
      continue;
    }
    emit(undefined, ch);
    i++;
    atLineStart = false;
    prevWord = "";
  }
  return { html: pieces.map((p) => p.join("")), inString };
}

export function highlightLines(source: string[]): string[] {
  return highlightSource(source).html;
}
