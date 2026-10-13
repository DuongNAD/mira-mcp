[Tiếng Việt](README.vi.md) | English

<p align="center"><img src="docs/banner.jpg" alt="Mira MCP — Mira, the wonderful variable star, trailing its long tail" width="100%"></p>

# Mira MCP

*Named after Mira (omicron Ceti, "the wonderful"), the first known variable star: its brightness changes over time, like program state changing line by line.*

Mira is the code-tracing lab of the learner's MCP ecosystem. It runs **real Python** under a tracer, records every executed line with the variables it changed, and builds **one self-contained HTML player** that steps through the code line by line beside a live visualisation (array, grid, graph, statevector, plot, table, stack, queue, heap). At the stops you choose, the learner must **type what will happen before the player reveals it**.

---

## Ecosystem

All projects by DuongNAD:

| Project | Role | Repository |
| :--- | :--- | :--- |
| **Polaris** | Course architect & syllabus engine; receives Mira's missed predictions in its error log | [polaris-mcp](https://github.com/DuongNAD/polaris-mcp) |
| **Aurora Slides** | Lessons & presentation engine; embeds Mira players in a `trace` slide | [aurora-slides-mcp](https://github.com/DuongNAD/aurora-slides-mcp) |
| **SmartDrive-OS** | SSD governance & learning search; indexes what Mira writes | [smart-drive-os](https://github.com/DuongNAD/smart-drive-os) |
| **Constellation** | MCP registration & ecosystem contracts | [constellation-mcp](https://github.com/DuongNAD/constellation-mcp) |
| **Vega** | Adaptive spaced repetition (FSRS); receives review cards in its inbox | [vega-mcp](https://github.com/DuongNAD/vega-mcp) |
| **Orion** | Practice labs & tutoring ladder; Mira traces a lab's entry file | [orion-mcp](https://github.com/DuongNAD/orion-mcp) |
| **Mira** | Real code traces, prediction gates, progress log | [mira-mcp](https://github.com/DuongNAD/mira-mcp) |

---

## Why Mira?

The learner saw a short video that animates A* line by line and wanted that for their own study. Research on algorithm and program visualisation says passive watching helps little; learning comes from **engagement** (predicting, answering, changing) at each step (Hundhausen, Douglas and Stasko 2002; Naps et al. 2002). Code tracing is also the skill measured most in the learner's exam: COS Pro Level 2 gives 440/1000 points to code reading and 280/1000 to debugging.

So Mira is an *active* tracer: real traces, prediction gates, and results logged in the ecosystem's progress format (`aurora-progress-event.v1`) so Polaris (error log) and Vega (cards) reuse them.

---

## Principles

1. **Real execution only**: every value shown comes from a recorded trace of the learner's Python. Mira never fabricates steps or values.
2. **Never the learner's solution**: Mira traces code that exists. `mira_drill` refuses functions that still contain fill-in placeholders (`___1___`). The only built-in demo is A* and Dijkstra on a grid, which is not one of the learner's assignments.
3. **Predict first**: stops ask before they reveal.
4. **Offline**: players work fully from `file://`; no CDN and no external URL of any kind in the generated HTML (fonts are inlined).
5. **Learner fit**: learner-facing text is Vietnamese with correct diacritics, no emoji (icons are inline SVG), calm dark theme by default.
6. **Process hygiene**: Python runs with `-B -X utf8` (no `__pycache__` on the exFAT drive), cwd = the traced file's folder, time-boxed, killed with its whole process tree on timeout (`taskkill /PID <pid> /T /F` on Windows), stdout/stderr capped.
7. **Toolchain discipline**: TypeScript strict, one esbuild bundle `dist/mira.mjs`, external toolchain via `MIRA_TOOLCHAIN`, no `node_modules` on D:.

---

## MCP Tools & CLI

| MCP Tool | CLI Command | Purpose |
|---|---|---|
| `mira_guide {topic?}` | `mira guide [topic]` | Topics: overview, record, build, viz, stops, drill, progress, rules, embed |
| `mira_record {file \| lab, call \| script, ...}` | `mira record <file> --call "<expr>" \| --script` | Run under the tracer, write `trace.json`, summary + suggested stops |
| `mira_build {spec}` | `mira build <spec.json>` | Validate against the trace, write `index.html`, print an Aurora slide |
| `mira_check {spec}` | `mira check <spec.json>` | Read-only validation with suggestions |
| `mira_drill {file \| lab, function?, call?, stops?}` | `mira drill <file> [function]` | Exam practice: record + stops in one call |
| `mira_demo {out_dir?}` | `mira demo [out_dir]` | A* vs Dijkstra on an 18x28 grid, hub page comparing visited cells |
| `mira_preview {dir, port?, stop?}` | `mira preview <dir> [--port n]` | 127.0.0.1 server; POST `/__mira/progress` appends to `progress.jsonl` |
| `mira_progress {dir? \| file?, to_vega?, hub?}` | `mira progress <dir\|file> [--to-vega] [--hub p]` | Summaries, error-log entries, Vega cards and inbox |

Every CLI command accepts `--json`.

---

## Quick start

```powershell
$env:MIRA_TOOLCHAIN = "C:\Users\Admin\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\aurora-slides\toolchain"
node scripts/build.mjs --check      # type-check (node + player/DOM) and bundle
node scripts/e2e.mjs                # real MCP stdio, CLI, preview server, player smoke tests
node dist/mira.mjs demo $env:TEMP\mira-demo
node dist/mira.mjs drill path\to\exercises.py my_function --out $env:TEMP\my-drill
```

### Record and build

```text
mira_record { file: "p1.py", call: "total(-4567)", probes: { sq: "total*total" } }
mira_check  { spec }
mira_build  { spec }
```

```json
{
  "title": "Sum of digits",
  "trace": "<path of trace.json>",
  "viz": [{ "kind": "array", "var": "digits", "pointers": ["i"] }],
  "counters": [{ "label": "TOTAL", "expr": "total" }, { "label": "Loop", "line_hits": 5 }],
  "stops": [
    { "at": { "line": 6, "hit": 2 }, "ask": "After this line, what is `total`?", "expect": { "expr": "total" }, "explain": "..." },
    { "at": { "line": 8 }, "ask": "What does the function return?", "expect": { "expr": "return" } }
  ],
  "narration": { "6": "Add the last digit." }
}
```

- `expr` is a variable name, a probe name, or `len(<name>)`, evaluated on the recorded state only (no Python at playback). Inside `expect.expr` the word `return` is the value returned by the stop's line.
- Stops: `value` (`expect.expr`), `line` (`expect.line_next`: which line runs next) or `choice` (`expect.choice` + `answer`).
- Viz kinds: `array`, `grid`, `graph`, `statevector`, `plot`, `table`, `stack`, `queue`, `heap` (at most 3 per player, shown as tabs).
- Counters accept `line_hits` (how many times a line has run) as an alternative to `expr`.

### The player

Dark by default (light theme toggle), two columns at 1100 px and above, stacked below, no horizontal scroll at 390 px. Code window with two markers (the line that just ran: accent bar; the line about to run: outline), variables with soft flashes for changed values, stdout, narration caption, scrubber with stop ticks, speed control.

With no viz configured (typical for numeric drills) the left panel shows an exam-style **trace table** whose rows appear only as the run reaches them (it never shows the result ahead of time).

Keys: `Left`/`Right` step, `Space` play/pause, `Home`/`End`, `N` next stop. Reduced motion is respected. `index.html#stop-3` opens the player at stop 3 (used by Vega review cards).

At a stop the player pauses and asks. The learner types a Python literal (`7`, `[1, 2]`, `'abc'`, `True`, a dict or set); `3` equals `3.0`, `[1, 2]` equals `(1, 2)`, strings are trimmed, sets and dicts ignore order. The reveal shows `Đúng` or `Khác dự đoán`, the real value and the explanation. "Bỏ qua" (or scrubbing past a stop) records a miss.

---

## Ecosystem integration

| Integration | How |
|---|---|
| **Progress contract** | Per stop: `{v:1, t, course, lesson, deck, slide, slideId:"mira-stop-<k>", type:"predict", title, prediction, rating:"right"\|"different", output}`; once at the end `{type:"complete", slides, quiz:null, predictions:"x/y"}`. Saved to `localStorage` (`mira:<slug>:events`, 1000), POSTed to `/__mira/progress` when served over http, and exportable with the "Xuất tiến độ" button as `aurora-progress-mira-<slug>.jsonl`. |
| **Aurora embed** (`mira-embed.v1`) | Embed mode when `window.parent !== window` or `?embed=1`: compact layout, shortcuts only while the iframe has focus, `Escape` posts `{source:"mira",v:1,kind:"blur"}`; the player posts `ready` and every `event` to the parent (no POST to `/__mira/progress`) and accepts `{source:"aurora",v:1,kind:"hello",theme,accent}`. `mira_build` returns a ready-to-paste slide `{"type":"trace","eyebrow":"Dò code","title","player","caption"}`; Mira never writes into Aurora deck folders. |
| **Orion lab** | `lab` points at a lab folder: Mira traces `<lab>/<entry>`; events use `course = lab.subject`, `lesson = lab.module \|\| lab.title`. |
| **Polaris** | `mira_progress` returns `errorLogEntries` (`why: "Dự đoán sai khi dò code: <question>"`) ready for `polaris_errorlog_add`. Mira does not write into Polaris folders. |
| **Vega** | `vegaCards` for `vega_add`, or `to_vega: true` drops ONE `vega-card-inbox.v1` file into `<hub>/.vega/inbox/` (producer `mira`, key `mira:<slug>:stop-<k>`, origin `mira-stop`, `href` to `index.html#stop-<k>`). Hub: `hub` parameter, `MIRA_HUB`, `POLARIS_HUB`, then `D:/02_Learning_Knowledge`. |
| **SmartDrive** | After writing outputs on the SmartDrive volume, Mira fires `smart-drive update <dir> --quiet` (detached, debounced, failures ignored). Off with `MIRA_SMARTDRIVE=off`; override with `MIRA_SMARTDRIVE_CMD`. |

`progress.jsonl` and `aurora-progress-*.jsonl` are covered by the `personal-data` contract.

---

## Trace format

`trace.json`: `{v:1, tool:"mira", file, call|script, created, python, focus, steps, result?, resultValue?, stdout, stderr, error?, truncated, lines, source, ...}`. Steps are `call`, `line` (`{i, line, func, depth, fid, locals, types, changed, probes?, out}` where `line` is the line ABOUT TO RUN and `locals` the state before it runs), `return` and `exception` events. Values: ints, floats (integral and non-finite floats are tagged so `3.0` stays a float), bools, `None`, strings, lists, tuples, dicts, sets, complex, numpy arrays, objects with `__dict__`; large containers are truncated with their true length kept.

The player embeds the trace compactly: per step only the variables that changed, and container-level patches (a growing `visited` set costs one element per step, not a copy).

Environment: `MIRA_PYTHON` (Python 3), `MIRA_TOOLCHAIN`, `MIRA_HUB`, `MIRA_SMARTDRIVE`, `MIRA_SMARTDRIVE_CMD`. Python resolution: `MIRA_PYTHON` -> `python` -> `py -3`.

---

## Development

```powershell
node scripts/build.mjs --check   # tsc strict (node config) + tsc strict (DOM lib for src/player)
node scripts/e2e.mjs             # fixtures under %TEMP%; the player runs on a fake DOM, and a few layout checks run in
                                 # headless Chrome when it is installed (skipped with a note otherwise)
node scripts/shots.mjs           # layout QA in headless Chrome with real device emulation: an overflow table plus
                                 # screenshots under %TEMP%\mira-shots (options: --fixtures --sweep --only --reuse)
```

`scripts/shots.mjs` drives Chrome over the DevTools protocol with Node's global WebSocket (no npm packages) and a throwaway profile. Use it instead of `chrome --headless --window-size=390,844`: Chrome on Windows will not make a window narrower than about 500 px, so that command shows a wider layout cropped to 390 px, which looks like overflow but is not.

---

## License

MIT License (c) 2026 DuongNAD
