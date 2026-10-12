# Mira MCP - plan and design

Mira is the code-tracing lab of the learner's MCP ecosystem (DuongNAD): it runs real Python code under a tracer,
records every executed line with the variables it changed, and builds a self-contained HTML player that steps through
the code line by line beside a live visualisation, with prediction gates where the learner must type what will happen
before the player reveals it. Named after Mira (omicron Ceti, "the wonderful"), the first known variable star:
its brightness changes over time, like program state changing line by line.

## Why
The learner saw a short video that animates A* line by line and wants that for their own study. Research on algorithm
and program visualisation says passive watching helps little; learning comes from engagement (predicting, answering,
changing) at each step (Hundhausen, Douglas and Stasko 2002; Naps et al. 2002). Code tracing is also the skill
measured most in the learner's exam: COS Pro Level 2 gives 440/1000 points to code reading and 280/1000 to debugging.
So Mira is an active tracer: real traces, prediction gates, results logged in the ecosystem's progress format so
Polaris (error log) and Vega (cards) reuse them.

## Principles
1. Real execution only. Mira never fabricates steps or values.
2. Never the learner's solution. `mira_drill` refuses functions with `___n___` placeholders; the only built-in demo is
   A* and Dijkstra on a grid. No demos of gradient descent, statevector simulators, sorting, regressions, KNN, trees,
   ReAct loops, BFS/heap problems: those are the learner's own exercises (the e2e fixtures are generic toy code under %TEMP%).
3. Same toolchain discipline as the sister projects: TypeScript strict, one esbuild bundle `dist/mira.mjs`, shared
   toolchain via `MIRA_TOOLCHAIN` -> `ORION_TOOLCHAIN` -> `VEGA_TOOLCHAIN` -> `POLARIS_TOOLCHAIN` -> default; no npm
   install and no node_modules on D:; no recursive scans of D:; fixtures under %TEMP%.
4. Players work offline from `file://`: no CDN, no external URL (fonts inlined as data URIs).
5. Vietnamese learner text with diacritics, no emoji (inline SVG icons), Apple-keynote calm, dark by default.
6. Python hygiene: `-B -X utf8`, cwd = traced file's folder, time-boxed, killed with its process tree
   (`taskkill /PID <pid> /T /F`), stdout/stderr capped. Resolution: `MIRA_PYTHON` -> `python` -> `py -3`.

## Architecture
```
mira_record  -> tracer.py (sys.settrace, written to a temp dir per run) -> trace.json (full locals per line event)
mira_build   -> validate spec against trace -> compact steps (deltas + container patches) -> index.html
                (player JS + CSS + fonts + data inlined by the two-pass esbuild build)
mira_preview -> 127.0.0.1 static server + POST /__mira/progress (contract-validated)
mira_progress-> progress.jsonl -> summary, errorLogEntries, vegaCards, Vega inbox file
```
- Build: pass 1 bundles `src/player/main.ts` (browser iife, minified) and `player.css` in memory; pass 2 bundles
  `src/index.ts` with a plugin serving `virtual:player-js` / `virtual:player-css`. `--check` type-checks the node config
  and the player config (DOM lib) separately, in a work folder inside the toolchain (never on D:).
- Pure modules shared by Node and the player (`src/player/{types,delta,values,expr,compare,model,events,embed}.ts`) are
  unit-tested in Node from the bundle; the DOM code (`main.ts`, `ui/`, `viz/`) is exercised by a fake DOM
  (`scripts/fakedom.mjs`) because no browser is available to the test run.

### Trace format
Events: `call {i, func, line, depth, fid, args, types, out}`, `line {…, locals, types, changed, probes?}` (`line` is
the line ABOUT TO RUN; `locals` the state before it runs; `changed` the names whose serialized value differs from the
previous event of the same frame), `return {value, type, unwound?}`, `exception {type, message}`. `fid` identifies the
frame instance (needed for recursion); `depth` counts traced frames.

Serialization (JSON, deterministic): int/bool/None/str/float as JSON; tagged values for what JSON cannot say:
`{"__float__":"3.0"}` for integral and non-finite floats, `{"__int__":"…"}` beyond 2^53, `{"__str__":…,"n":N}` for
truncated strings, `{"__list__":…,"n":N}`, `{"__tuple__":…}`, `{"__set__":…}` (sorted), `{"__dict__":[[k,v],…]}`
when keys are not plain strings or the dict is truncated, `{"__complex__":[re,im]}`, `{"__ndarray__":{shape,dtype,data}}`,
`{"__obj__":name,"attrs":…}`, `{"__repr__":"…"}` (memory addresses stripped so recordings are reproducible).
Containers: lists 200 items, dicts 100, sets 1000, depth 3.

### Compact embedding
Storing full locals per step makes a 4000-step search (a visited set growing by one cell per step) several MB. The
builder keeps, per step, only variables that changed and replaces changed containers by patches relative to the
previous value of the same variable (`d`/`D` dict, `l` list: truncate/set/append, `s` set: add/remove). The player
rebuilds the state lazily with structural sharing (`Model.frameState`), and the e2e proves the rebuilt state equals the
recorded locals for every step of the demo traces.

### Step semantics
Player steps are the `line`, `return` and `exception` events (a `call` is folded into the first line of the callee).
At step k: the "just executed" marker is the line of step k-1, the "about to run" marker is the line of step k. A stop
is anchored at a line event; its outcome is the next event of the same frame (so a call to another traced function in
between does not matter). `expect.expr` is evaluated there; `return` is the value returned by the line.

## Tools (8) and CLI
`mira_guide`, `mira_record`, `mira_build`, `mira_drill`, `mira_demo`, `mira_preview`, `mira_progress`, `mira_check`;
CLI mirrors them (`record`, `build`, `check`, `drill`, `demo`, `preview`, `progress`, `guide`, `version`, `help`, `--json`).

## Integration (addenda)
- Embed protocol `mira-embed.v1` for Aurora's `trace` slide (iframe): detection, compact layout, `ready`/`event`/`blur`
  messages out, `hello` in; `mira_build` prints the slide JSON; Mira never writes into deck folders.
- Orion labs: `lab` on `mira_record`/`mira_drill` reads `lab.json` (`entry`, `title`, `subject`, `module`).
- SmartDrive post-write hook: `smart-drive update <dir> --quiet`, detached, debounced, only on the SmartDrive volume;
  `MIRA_SMARTDRIVE=off`, `MIRA_SMARTDRIVE_CMD`, `MIRA_SMARTDRIVE_ROOT`.
- Single review queue: `mira_progress { to_vega: true }` writes one `vega-card-inbox.v1` file per call into
  `<hub>/.vega/inbox/` (key `mira:<slug>:stop-<k>`); `index.html#stop-<k>` deep links reopen a stop.
- Events validated against `aurora-progress-event.v1` (local replica and the constellation validator).

## Deviations from the first spec (all additive or clarifying)
- Floats: integral and non-finite floats are tagged objects instead of bare numbers or the strings "inf"/"nan", so
  `3.0` and `"inf"` cannot be confused with an int or a string.
- Dicts: plain JSON objects only when every key is a plain, non-index-like string; otherwise `{"__dict__": pairs}` keeps
  the real key types (`{1: 'a'}` vs `{'1': 'a'}`) and insertion order.
- Sets are sorted naturally (numbers, strings, tuples), falling back to repr order, instead of always by repr.
- Events carry `fid` and `types`; `return` events may carry `unwound`.
- Counters accept `line_hits` as an alternative to `expr` (used by the drill's loop counter).
- Truncated strings, lists and sets carry their true length so `len(x)` stays right.

## Tests (e2e under %TEMP%)
Server identity, 8 tools, guide topics; record (loop accumulator, changed flags, probes, truncation, infinite loop
killed with a partial trace, exceptions, focus filtering, stdout offsets, numpy/complex serialization, determinism, no
`__pycache__`); compare unit checks; delta round-trips and model-vs-trace equality; build (embedded data, no external
URLs, <3 MB, meta tags, Aurora slide) and check errors with suggestions; drill (docstring call, refusal of
placeholders, closest function name, real `tong_chu_so` file read-only); demo (A* visited < Dijkstra, same path);
player on a fake DOM (all viz kinds, gates, events over http and in embed mode, deep link, autoplay, keyboard);
preview (static, traversal, POST validation/size/origin); progress and Vega inbox; Orion lab; SmartDrive hook with a
fake command; CLI; contract validation of every emitted event.

Layout in a real browser (skipped with a note when Chrome or Edge is missing; `MIRA_CHROME` overrides the path): the e2e
drives headless Chrome with device emulation through `scripts/shots.mjs` and checks a copy of the A* demo page at
1366x768, embed 960x540, phones 390 and 360, a phone-width embed, an open prediction gate and the widest header state.
Nothing may stick out of the viewport (scrollWidth <= clientWidth), no caption line may be cut at any of the 983
steps, the code pane scrolls inside itself, the grid canvas takes its container's width, the control bar stays compact
and the gate stays clear of it. `node scripts/shots.mjs [--fixtures] [--sweep]` runs the whole matrix (about 80 cases
and 1500 viewport sizes between 320 and 1920 px, normal, gate-answered and embed layouts) and saves screenshots under
%TEMP%. Do not judge layout with `chrome --headless --window-size=390,844`: Chrome on Windows enforces a minimum
window width of about 500 px, so that shows a wider layout cropped to 390 px (looks like overflow, is not).

## Status
- 2026-10-12: v0.1 built and verified: `node scripts/build.mjs --check` types OK (node and player/DOM configs), `node scripts/e2e.mjs`
  258 ok / 0 FAIL (two consecutive runs identical), demo and the real `tong_chu_so` drill generated under %TEMP%.
- 2026-10-12 (visual QA): layout verified in headless Chrome with device emulation (`scripts/shots.mjs`). The
  reported cut-off at 390 px was an artifact of the plain `--window-size` screenshot; real problems found and fixed:
  header actions (score pill, toast) overflowing and crushing the title on phones, the control bar bleeding past a
  phone-width embed, the embed two-column shell widening the page at 760 to 790 px, captions cut in half (555 of 983
  steps at 390 px), the prediction gate hiding behind the sticky bar, a control bar of 22% of a phone screen, and
  graph, plot and heap text of about 6 px on phones. Desktop 1366x768 is pixel-identical before and after.
  e2e 289 ok / 0 FAIL.
- Known limitations: generators show each resume as a new call; async code is traced as ordinary frames; threads are
  not traced; only the main file is traced (library frames are skipped by design); layout was verified in Chrome only
  (Safari and Firefox were not run).
