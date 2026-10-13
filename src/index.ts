/**
 * Mira MCP: step-through Python code tracer with a self-contained HTML player and prediction gates.
 *
 *   node dist/mira.mjs                          -> MCP server on stdio
 *   node dist/mira.mjs record <file> --call "<expr>" | --script   -> record a real trace
 *   node dist/mira.mjs build <spec.json>        -> build the HTML player
 *   node dist/mira.mjs check <spec.json>        -> validate a spec against its trace (no writes)
 *   node dist/mira.mjs drill <file> [function] [--call "<expr>"]  -> exam-practice player
 *   node dist/mira.mjs demo [out_dir]           -> A* / Dijkstra demo
 *   node dist/mira.mjs preview <dir> [--port n] -> local preview server (Ctrl-C to stop)
 *   node dist/mira.mjs progress <dir|file>      -> summarise predictions, export misses
 *   node dist/mira.mjs guide [topic]            -> guide
 *   node dist/mira.mjs version | help
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildPlayer, checkSpec } from "./build.js";
import { buildDemo } from "./demo.js";
import { runDrill } from "./drill.js";
import { GUIDE_TOPICS, getGuideTopic } from "./guide.js";
import { startPreview, stopPreview } from "./preview.js";
import { formatProgress, readProgress, resolveHub, writeVegaInbox } from "./progress.js";
import { recordTrace } from "./record.js";
import { drillShape, recordShape } from "./schema.js";
import { VERSION, errMsg } from "./util.js";

export * from "./build.js";
export * from "./demo.js";
export * from "./drill.js";
export * from "./guide.js";
export * from "./highlight.js";
export * from "./lab.js";
export * from "./player/compare.js";
export * from "./player/delta.js";
export * from "./player/embed.js";
export * from "./player/events.js";
export * from "./player/expr.js";
export * from "./player/model.js";
export * from "./player/values.js";
export * from "./preview.js";
export * from "./progress.js";
export * from "./python.js";
export * from "./record.js";
export * from "./schema.js";
export * from "./smartdrive.js";
export * from "./tracer_py.js";
export * from "./util.js";

type Content = { type: "text"; text: string };
type ToolResult = { content: Content[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true } : {}),
});

async function safe(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return text(errMsg(e), true);
  }
}

export const INSTRUCTIONS = `Mira MCP is the code-tracing lab of the learning hub: it runs real Python under a tracer, records every executed line with the variables it changed, and builds one self-contained HTML player that steps through the code beside a live visualisation, with prediction gates where the learner must type what will happen before the player reveals it.

Workflow:
1. mira_guide { topic? } to read the topics (overview, record, build, viz, stops, drill, progress, rules, embed).
2. mira_record { file | lab, call | script } to record a real trace; read the summary (hot lines, variables, suggested stops).
3. Write a build spec with 1-3 viz, counters and 3-8 stops at the lines that carry the idea, then mira_check { spec } and mira_build { spec }. For exam practice use mira_drill { file, function } which derives the call from the docstring example.
4. Open the player (mira_preview { dir } or the file itself); the learner predicts at each stop.
5. mira_progress { dir } to read results; export misses to polaris_errorlog_add and vega_add, or mira_progress { to_vega: true } to drop review cards into the Vega inbox.

Rules:
- Real traces only: every value shown comes from a recorded run; Mira never fabricates steps or values.
- Never write the learner's solutions: mira_drill refuses functions that still contain ___n___ placeholders; the only built-in demo is A* and Dijkstra on a grid.
- Stops ask before revealing; learner-facing text is Vietnamese with correct diacritics and no emoji.
- Players work offline from file:// (no CDN); Python runs with -B -X utf8, time-boxed, killed with its process tree on timeout.
- No recursive scans of D:; no npm install on D:.
- Code found by Rigel's search_material prints its file path; trace it with mira_record.

Done when:
The player builds without errors from a real trace, the learner's predictions are logged in the aurora-progress-event.v1 format, and misses are exported to the error log and Vega.`;

export function createServer(): McpServer {
  const server = new McpServer({ name: "mira", version: VERSION }, { instructions: INSTRUCTIONS });

  /* 1. mira_guide */
  server.registerTool(
    "mira_guide",
    {
      title: "Mira Guide",
      description: "READ FIRST. Documentation on recording traces, build specs, viz kinds, prediction stops, drills, progress export and the embed protocol. No argument = topic list.",
      inputSchema: {
        topic: z.enum(GUIDE_TOPICS).optional().describe(`Topic: ${GUIDE_TOPICS.join(" | ")}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ topic }) => safe(async () => text(getGuideTopic(topic))),
  );

  /* 2. mira_record */
  server.registerTool(
    "mira_record",
    {
      title: "Record a Real Python Trace",
      description:
        "Run a Python file (or an Orion lab entry) under a tracer and write trace.json: every executed line with the variables it changed, calls, returns and exceptions. Exactly one of call (expression) or script. Runs with -B -X utf8, time-boxed, process tree killed on timeout. Returns a summary and suggested stops.",
      inputSchema: recordShape,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) =>
      safe(async () => {
        const r = await recordTrace(args);
        return text(r.text, !r.ok);
      }),
  );

  /* 3. mira_build */
  server.registerTool(
    "mira_build",
    {
      title: "Build the HTML Player",
      description:
        "Validate a build spec against its trace and write a self-contained, offline index.html (code window, variables, stdout, viz, counters, prediction stops). Also returns a ready-to-paste Aurora trace slide. Run mira_check first.",
      inputSchema: {
        spec: z.unknown().describe("Build spec: {title, trace, viz[0..3], counters?, stops?, narration?, out_dir?, theme?, ...}"),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ spec }) =>
      safe(async () => {
        const r = await buildPlayer(spec);
        return text(r.text, !r.ok);
      }),
  );

  /* 4. mira_drill */
  server.registerTool(
    "mira_drill",
    {
      title: "Exam-Practice Drill",
      description:
        "Record one function and build a player with prediction stops (return value, loop accumulators). Derives the call from a docstring example `f(args) -> result` when missing. Refuses functions that still contain ___n___ placeholders (complete the blanks first).",
      inputSchema: drillShape,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) =>
      safe(async () => {
        const r = await runDrill(args);
        return text(r.text, !r.ok);
      }),
  );

  /* 5. mira_demo */
  server.registerTool(
    "mira_demo",
    {
      title: "A* and Dijkstra Demo",
      description:
        "Write grid_search.py (A* and Dijkstra on an 18x28 grid), record both, and build astar/index.html, dijkstra/index.html and a hub page comparing how many cells each examined. Default folder: <temp>/mira-demo.",
      inputSchema: {
        out_dir: z.string().optional().describe("Output folder (default <temp>/mira-demo)"),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ out_dir }) =>
      safe(async () => {
        const r = await buildDemo(out_dir);
        return text(r.text, !r.ok);
      }),
  );

  /* 6. mira_preview */
  server.registerTool(
    "mira_preview",
    {
      title: "Local Preview Server",
      description:
        "Serve a folder on 127.0.0.1 (default port 4319, next free if busy). GET is static and confined to the folder; POST /__mira/progress appends contract-valid events to <dir>/progress.jsonl. One server per folder; stop:true stops it.",
      inputSchema: {
        dir: z.string().min(1).describe("Folder to serve (a player folder or the demo hub)"),
        port: z.number().int().min(1).max(65535).optional().describe("Preferred port (default 4319)"),
        stop: z.boolean().optional().describe("Stop the server for this folder"),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ dir, port, stop }) =>
      safe(async () => {
        if (stop) {
          const stopped = stopPreview(dir);
          return text(stopped ? `Đã dừng máy chủ xem trước của ${resolve(dir)}.` : `Không có máy chủ xem trước nào đang chạy cho ${resolve(dir)}.`);
        }
        const info = await startPreview(dir, port);
        return text(
          `${info.reused ? "Máy chủ xem trước đang chạy" : "Đã mở máy chủ xem trước"}: ${info.url}\nThư mục: ${info.dir}\nTiến độ dự đoán sẽ được ghi vào ${resolve(dir, "progress.jsonl")}.`,
        );
      }),
  );

  /* 7. mira_progress */
  server.registerTool(
    "mira_progress",
    {
      title: "Read Prediction Progress",
      description:
        "Summarise predictions per player from <dir>/progress.jsonl and/or an exported file, and return errorLogEntries (for polaris_errorlog_add) and vegaCards (for vega_add). With to_vega:true also writes ONE inbox file into <hub>/.vega/inbox/ (vega-card-inbox.v1) for every missed or skipped stop. Never writes into Polaris folders.",
      inputSchema: {
        dir: z.string().optional().describe("Folder holding progress.jsonl (and the players)"),
        file: z.string().optional().describe("An exported aurora-progress-mira-*.jsonl file"),
        to_vega: z.boolean().optional().describe("Write missed stops to the Vega inbox"),
        hub: z.string().optional().describe("Learning hub root (default MIRA_HUB, POLARIS_HUB, then D:/02_Learning_Knowledge)"),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ dir, file, to_vega, hub }) =>
      safe(async () => {
        const opts: { dir?: string; file?: string; hub?: string } = {};
        if (dir) opts.dir = dir;
        if (file) opts.file = file;
        if (hub) opts.hub = hub;
        const summary = await readProgress(opts);
        let inbox: Awaited<ReturnType<typeof writeVegaInbox>> | { skipped: string } | undefined;
        if (to_vega) {
          inbox = (await writeVegaInbox(summary.inboxLines, hub)) ?? { skipped: "Không có điểm dừng sai hoặc bị bỏ qua để gửi cho Vega." };
        }
        return text(formatProgress(summary, inbox));
      }),
  );

  /* 8. mira_check */
  server.registerTool(
    "mira_check",
    {
      title: "Validate a Build Spec (read-only)",
      description:
        "Validate a build spec against its trace without writing anything: stop lines must have been hit enough times, expressions must resolve at that point, viz variables must exist in the trace. Lists errors (with suggestions) and warnings.",
      inputSchema: {
        spec: z.unknown().describe("Build spec to validate"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ spec }) =>
      safe(async () => {
        const r = await checkSpec(spec);
        const lines: string[] = [];
        lines.push(r.ok ? `Spec hợp lệ: ${r.steps} bước, ${r.stops?.length ?? 0} điểm dừng.` : "Spec chưa hợp lệ:");
        for (const e of r.errors) lines.push(`- Lỗi: ${e}`);
        for (const w of r.warnings) lines.push(`- Cảnh báo: ${w}`);
        for (const s of r.stops ?? []) lines.push(`  ${s.k}. [dòng ${s.line}, ${s.kind}] ${s.ask}`);
        return text(lines.join("\n"), !r.ok);
      }),
  );

  return server;
}

export async function startMcp(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/* ───────── CLI ───────── */

const VALUE_FLAGS = new Set(["call", "focus", "probe", "stdin", "max-steps", "timeout", "out", "name", "lab", "stops", "title", "port", "hub", "function", "theme"]);

interface Parsed {
  pos: string[];
  flags: Map<string, string[]>;
  bool: Set<string>;
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { pos: [], flags: new Map(), bool: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) {
        out.flags.set(name, [...(out.flags.get(name) ?? []), a.slice(eq + 1)]);
      } else if (VALUE_FLAGS.has(name)) {
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`Thiếu giá trị cho --${name}`);
        out.flags.set(name, [...(out.flags.get(name) ?? []), v]);
        i++;
      } else {
        out.bool.add(name);
      }
    } else {
      out.pos.push(a);
    }
  }
  return out;
}

const flag = (p: Parsed, name: string): string | undefined => p.flags.get(name)?.[p.flags.get(name)!.length - 1];
const num = (p: Parsed, name: string): number | undefined => {
  const v = flag(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} phải là số, nhận được "${v}"`);
  return n;
};

const HELP = `Mira MCP v${VERSION} - step-through Python code tracer with prediction gates

Usage:
  mira <command> [options]

Commands:
  record <file> --call "<expr>" | --script   Record a real trace (also: --lab <dir>, --focus a,b, --probe n=expr, --stdin t,
                                             --max-steps n, --timeout s, --out dir, --name n)
  build <spec.json>                          Build the self-contained HTML player
  check <spec.json>                          Validate a spec against its trace (no writes)
  drill <file> [function] [--call "<expr>"]  Exam-practice player (also: --lab, --stops n, --out dir, --title t)
  demo [out_dir]                             A* / Dijkstra demo (grid_search.py, astar/, dijkstra/, index.html)
  preview <dir> [--port n]                   Serve a folder on 127.0.0.1 and log progress (Ctrl-C to stop)
  progress <dir|file> [--to-vega] [--hub p]  Summarise predictions; export errorLogEntries / vegaCards / Vega inbox
  guide [topic]                              Guide (${GUIDE_TOPICS.join(", ")})
  version                                    Print the version (${VERSION})
  help                                       Show this help

Options:
  --json                                     Output machine-readable JSON`;

export async function cli(argv: string[]): Promise<number> {
  const cmd = argv[0]?.toLowerCase() ?? "help";
  const p = parseArgs(argv.slice(1));
  const isJson = p.bool.has("json");
  const print = (obj: unknown, human: string): void => {
    console.log(isJson ? JSON.stringify(obj, null, 2) : human);
  };

  switch (cmd) {
    case "version":
    case "-v":
    case "--version":
      console.log(VERSION);
      return 0;

    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return 0;

    case "guide": {
      const topic = p.pos[0];
      const content = getGuideTopic(topic);
      print({ topic: topic ?? "overview", topics: GUIDE_TOPICS, content }, content);
      return 0;
    }

    case "record": {
      const file = p.pos[0];
      const input: Record<string, unknown> = {};
      if (file) input.file = file;
      const call = flag(p, "call");
      if (call !== undefined) input.call = call;
      if (p.bool.has("script")) input.script = true;
      const lab = flag(p, "lab");
      if (lab) input.lab = lab;
      const focus = flag(p, "focus");
      if (focus) input.focus = focus.split(",").map((s) => s.trim()).filter(Boolean);
      const probes = p.flags.get("probe");
      if (probes?.length) {
        const map: Record<string, string> = {};
        for (const pr of probes) {
          const eq = pr.indexOf("=");
          if (eq <= 0) throw new Error(`--probe cần dạng tên=biểu_thức, nhận được "${pr}"`);
          map[pr.slice(0, eq).trim()] = pr.slice(eq + 1);
        }
        input.probes = map;
      }
      const stdin = flag(p, "stdin");
      if (stdin !== undefined) input.stdin = stdin;
      const maxSteps = num(p, "max-steps");
      if (maxSteps !== undefined) input.max_steps = maxSteps;
      const timeout = num(p, "timeout");
      if (timeout !== undefined) input.timeout_sec = timeout;
      const out = flag(p, "out");
      if (out) input.out_dir = out;
      const name = flag(p, "name");
      if (name) input.name = name;
      const r = await recordTrace(input);
      const trace = r.trace;
      print(
        {
          ok: r.ok,
          timedOut: r.timedOut,
          tracePath: r.tracePath,
          outDir: r.outDir,
          events: r.summary?.events,
          lineEvents: r.summary?.lineEvents,
          truncated: trace?.truncated,
          result: trace?.result,
          error: trace?.error,
          stdout: trace?.stdout,
          functions: r.summary?.functions,
          hotLines: r.summary?.hotLines,
          variables: r.summary?.variables,
          suggestedStops: r.summary?.suggestedStops,
          warnings: r.warnings,
          text: r.ok ? undefined : r.text,
        },
        r.text,
      );
      return r.ok ? 0 : 1;
    }

    case "build":
    case "check": {
      const specPath = p.pos[0];
      if (!specPath) {
        console.error(`Usage: mira ${cmd} <spec.json> [--json]`);
        return 1;
      }
      const abs = resolve(specPath);
      if (!existsSync(abs)) {
        console.error(`Không tìm thấy spec: ${abs}`);
        return 1;
      }
      const spec: unknown = JSON.parse(readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
      const baseDir = dirname(abs);
      if (cmd === "check") {
        const r = await checkSpec(spec, { baseDir });
        const human = [
          r.ok ? `Spec hợp lệ: ${r.steps} bước, ${r.stops?.length ?? 0} điểm dừng.` : "Spec chưa hợp lệ:",
          ...r.errors.map((e) => `- Lỗi: ${e}`),
          ...r.warnings.map((w) => `- Cảnh báo: ${w}`),
        ].join("\n");
        print({ ok: r.ok, errors: r.errors, warnings: r.warnings, steps: r.steps, stops: r.stops }, human);
        return r.ok ? 0 : 1;
      }
      const r = await buildPlayer(spec, { baseDir });
      print(
        {
          ok: r.ok,
          indexPath: r.indexPath,
          bytes: r.bytes,
          steps: r.steps,
          stops: r.stops,
          errors: r.errors,
          warnings: r.warnings,
          auroraSlide: r.auroraSlide,
        },
        r.text,
      );
      return r.ok ? 0 : 1;
    }

    case "drill": {
      const input: Record<string, unknown> = {};
      const lab = flag(p, "lab");
      if (lab) input.lab = lab;
      if (p.pos[0]) input.file = p.pos[0];
      const fn = p.pos[1] ?? flag(p, "function");
      if (fn) input.function = fn;
      const call = flag(p, "call");
      if (call) input.call = call;
      const stops = num(p, "stops");
      if (stops !== undefined) input.stops = stops;
      const out = flag(p, "out");
      if (out) input.out_dir = out;
      const title = flag(p, "title");
      if (title) input.title = title;
      const r = await runDrill(input);
      print(
        { ok: r.ok, indexPath: r.indexPath, tracePath: r.tracePath, call: r.call, stops: r.stops, warnings: r.warnings, auroraSlide: r.auroraSlide, text: r.ok ? undefined : r.text },
        r.text,
      );
      return r.ok ? 0 : 1;
    }

    case "demo": {
      const r = await buildDemo(p.pos[0]);
      print(
        {
          ok: r.ok,
          outDir: r.outDir,
          hubPath: r.hubPath,
          astar: r.astar,
          dijkstra: r.dijkstra,
          fewerCells: r.fewerCells,
          auroraSlides: r.auroraSlides,
          warnings: r.warnings,
        },
        r.text,
      );
      return r.ok ? 0 : 1;
    }

    case "preview": {
      const dir = p.pos[0];
      if (!dir) {
        console.error("Usage: mira preview <dir> [--port n] [--json]");
        return 1;
      }
      const info = await startPreview(dir, num(p, "port"));
      print(info, `Máy chủ xem trước: ${info.url}\nTiến độ ghi vào ${resolve(dir, "progress.jsonl")}\nNhấn Ctrl-C để dừng.`);
      await new Promise<never>(() => undefined); // keep serving until the process is interrupted
      return 0;
    }

    case "progress": {
      const target = p.pos[0];
      if (!target) {
        console.error("Usage: mira progress <dir|file> [--to-vega] [--hub path] [--json]");
        return 1;
      }
      const abs = resolve(target);
      const opts: { dir?: string; file?: string; hub?: string } = {};
      if (existsSync(abs) && statSync(abs).isFile()) opts.file = abs;
      else opts.dir = abs;
      const hub = flag(p, "hub");
      if (hub) opts.hub = hub;
      const summary = await readProgress(opts);
      let inbox: Awaited<ReturnType<typeof writeVegaInbox>> | { skipped: string } | undefined;
      if (p.bool.has("to-vega")) {
        inbox = (await writeVegaInbox(summary.inboxLines, hub)) ?? { skipped: "Không có điểm dừng sai hoặc bị bỏ qua để gửi cho Vega." };
      }
      print({ ...summary, hub: p.bool.has("to-vega") ? resolveHub(hub) : undefined, inbox }, formatProgress(summary, inbox));
      return 0;
    }

    default:
      console.error(`Unknown command: ${cmd}. Run 'mira help' for usage.`);
      return 1;
  }
}

// Entrypoint
const isMain =
  Boolean(process.argv[1]) &&
  (resolve(process.argv[1]!) === fileURLToPath(import.meta.url) || basename(process.argv[1]!).startsWith("mira"));

if (isMain) {
  const isCli = process.argv.length > 2 && !["mcp"].includes(process.argv[2]!);
  if (isCli) {
    cli(process.argv.slice(2))
      .then((code) => {
        if (code !== 0) process.exit(code);
      })
      .catch((err) => {
        console.error(errMsg(err));
        process.exit(1);
      });
  } else {
    startMcp().catch((err) => {
      console.error("Failed to start Mira MCP server:", errMsg(err));
      process.exit(1);
    });
  }
}
