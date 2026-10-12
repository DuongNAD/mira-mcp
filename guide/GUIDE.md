# Mira MCP Guide

Mira is the code-tracing lab of the learner's MCP ecosystem: it runs real Python under a tracer, records every executed line with the variables it changed, and builds one self-contained HTML player that steps through the code beside a live visualisation, with prediction gates where the learner must type what will happen before the player reveals it. Named after Mira (omicron Ceti), the first known variable star: brightness changes over time, like program state changing line by line.

## Ecosystem Table

| Project | Author | Role in Learning Hub |
|---|---|---|
| **Polaris** | DuongNAD | Course architect, roadmaps, facts, and the error log ("Sổ lỗi") |
| **Aurora Slides** | DuongNAD | Keynote-grade lessons; embeds Mira players in a `trace` slide |
| **SmartDrive-OS** | DuongNAD | SSD storage governance, indexing, and fast learning search |
| **Constellation** | DuongNAD | MCP registration, health checks, and contracts |
| **Vega** | DuongNAD | Adaptive spaced repetition (FSRS); one review queue for every producer |
| **Orion** | DuongNAD | Practice labs; Mira traces a lab's entry file |
| **Mira** | DuongNAD | Real code traces, prediction gates, progress log |

---

## 1. Principles

1. **Real execution only**: values come from a recorded run, never from a model of it.
2. **Never the solution**: Mira traces code that exists; `mira_drill` refuses `___n___` placeholders; the only demo is A* and Dijkstra.
3. **Predict first**: stops ask, then reveal.
4. **Offline and calm**: one HTML file, no CDN, Vietnamese text, no emoji, dark by default.
5. **Hygiene**: Python with `-B -X utf8`, time-boxed, process tree killed; no recursive scans of D:; no `node_modules` on D:.

---

## 2. Workflow

1. `mira_record { file | lab, call | script, focus?, probes?, max_steps?, timeout_sec? }`
2. Read the summary: hot lines, variables with types, up to 6 suggested stops.
3. Write a build spec: 1-3 viz, counters, 3-8 stops at the lines that carry the idea.
4. `mira_check { spec }` then `mira_build { spec }` (prints an Aurora slide for the deck).
5. Open the player (`mira_preview { dir }` to also log progress) and predict at each stop.
6. `mira_progress { dir }`; send misses to `polaris_errorlog_add` and `vega_add`, or `to_vega: true` for the Vega inbox.

For exam practice: `mira_drill { file, function }` does steps 1-4 in one call.

---

## 3. Build spec

```json
{
  "title": "Sum of digits", "subtitle": "total(-4567)", "course": "Python", "lesson": "1.03",
  "trace": "<path to trace.json>", "out_dir": "<folder, default next to the trace>", "theme": "dark",
  "viz": [{ "kind": "array", "var": "arr", "pointers": ["i"] }],
  "counters": [{ "label": "TOTAL", "expr": "total" }, { "label": "Loop", "line_hits": 5 }],
  "stops": [{ "at": { "line": 6, "hit": 2 }, "ask": "After this line, what is `total`?", "expect": { "expr": "total" } }],
  "narration": { "6": "Add the last digit." },
  "start_step": 0, "autoplay_ms": 600
}
```

| Viz kind | Parameters |
|---|---|
| `array` | `var`, `pointers?`, `title?` |
| `grid` | `var?` (2D list) or `rows`+`cols`, `walls?`, `visited?`, `frontier?`, `path?`, `current?`, `start?`, `goal?` |
| `graph` | `nodes` (dict id -> {x, y, label?}) or `adjacency` (dict id -> ids or [id, w]), `visited?`, `frontier?`, `current?`, `labels?` |
| `statevector` | `var` (complex list or numpy array); bars of \|amplitude\|^2, phase dial, table toggle |
| `plot` | `var` (list of numbers), `y_label?` |
| `table` | `var` (dict or list) |
| `stack` / `queue` / `heap` | `var` |

Stops: `at` is `{line, hit?}` or `{step}`; `expect` is `{expr}`, `{line_next: true}` or `{choice: [...], answer}`; optional `explain`, `tolerance`. `expr` is a variable, a probe or `len(name)` evaluated after the stop's line ran (`return` = the value the line returns).

---

## 4. MCP Tools & CLI Commands

| MCP Tool | CLI Command | Purpose |
|---|---|---|
| `mira_guide {topic?}` | `mira guide [topic]` | overview, record, build, viz, stops, drill, progress, rules, embed |
| `mira_record {...}` | `mira record <file> --call "<expr>" \| --script` | Record a real trace |
| `mira_build {spec}` | `mira build <spec.json>` | Write the player; print the Aurora slide |
| `mira_check {spec}` | `mira check <spec.json>` | Validate without writing |
| `mira_drill {...}` | `mira drill <file> [function] [--call "<expr>"]` | Exam-practice player |
| `mira_demo {out_dir?}` | `mira demo [out_dir]` | A* / Dijkstra demo with a hub page |
| `mira_preview {dir, port?, stop?}` | `mira preview <dir> [--port n]` | Local server; progress POST |
| `mira_progress {dir? \| file?, to_vega?, hub?}` | `mira progress <dir\|file> [--to-vega] [--hub p]` | Summaries and exports |

---

## 5. Integration contracts

- **aurora-progress-event.v1**: predict events with `slideId: "mira-stop-<k>"`, `title` = the question, `deck` = player title; one `complete` event at the end.
- **mira-embed.v1**: iframe embedding for Aurora (see `mira_guide { topic: "embed" }`).
- **vega-card-inbox.v1**: `to_vega` writes `<hub>/.vega/inbox/mira-<UTC stamp>-<6 hex>.jsonl`, keys `mira:<slug>:stop-<k>`.
- **post-write-hook**: `smart-drive update <dir> --quiet` after writes on the SmartDrive volume (`MIRA_SMARTDRIVE=off` to disable).
- **personal-data**: `progress.jsonl` and `aurora-progress-*.jsonl` stay out of git.
