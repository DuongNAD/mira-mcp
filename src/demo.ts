/**
 * mira_demo: A* and Dijkstra on an 18x28 grid (the only built-in demo; it is not one of the learner's exercises).
 * Records both searches, builds astar/index.html and dijkstra/index.html, and a hub page that compares them.
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import playerCss from "virtual:player-css";
import { type AuroraSlide, type BuildResult, buildPlayer } from "./build.js";
import { recordTrace } from "./record.js";
import type { BuildSpecInput, LineEvent, Trace } from "./schema.js";
import { notifySmartDrive } from "./smartdrive.js";
import { VERSION, atomicWriteFile, esc } from "./util.js";

export const GRID_SEARCH_PY = `"""Tìm đường trên lưới 18x28 bằng A* và Dijkstra.

Đây là chương trình mẫu của Mira (không phải bài tập). Hai thuật toán dùng chung một khung:
lấy ô có độ ưu tiên nhỏ nhất trong hàng đợi ưu tiên (heapq), đánh dấu đã xét, rồi đẩy các ô kề
vào hàng đợi. Khác biệt duy nhất: A* cộng thêm h (khoảng cách Manhattan tới đích) vào độ ưu tiên,
tức f = g + h; Dijkstra chỉ dùng g.
"""
import heapq

ROWS, COLS = 18, 28
START = (9, 4)
GOAL = (9, 23)
INF = 10 ** 9


def make_grid():
    """Lưới 18x28: 0 là ô trống, 1 là tường (ba đoạn tường)."""
    grid = [[0] * COLS for _ in range(ROWS)]
    for r in range(0, 11):        # tường dọc ở cột 10
        grid[r][10] = 1
    for c in range(10, 16):       # tường ngang ở hàng 10, nối với tường dọc
        grid[10][c] = 1
    for r in range(10, 17):       # tường dọc ở cột 19, phía dưới
        grid[r][19] = 1
    return grid


def manhattan(a, b):
    """Khoảng cách Manhattan: số bước đi ngang và dọc nếu không có tường."""
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def neighbors(grid, cell, visited):
    """Các ô kề (trên, dưới, trái, phải) không phải tường và chưa được xét."""
    r, c = cell
    result = []
    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        nr, nc = r + dr, c + dc
        if 0 <= nr < ROWS and 0 <= nc < COLS and grid[nr][nc] == 0 and (nr, nc) not in visited:
            result.append((nr, nc))
    return result


def build_path(came_from, goal):
    """Đi ngược từ đích về ô xuất phát theo came_from rồi đảo lại."""
    path = [goal]
    while path[-1] in came_from:
        path.append(came_from[path[-1]])
    path.reverse()
    return path


def a_star(grid, start, goal):
    """A*: lấy ra ô có f = g + h nhỏ nhất. g: số bước từ xuất phát, h: Manhattan tới đích."""
    pq = [(manhattan(start, goal), 0, start)]    # (f, g, ô)
    best_g = {start: 0}                          # g tốt nhất đã biết của từng ô
    came_from = {}                               # ô -> ô đứng ngay trước nó
    visited = set()                              # các ô đã xét xong
    while pq:
        f, g, cell = heapq.heappop(pq)
        if cell in visited:
            continue
        visited.add(cell)
        if cell == goal:
            path = build_path(came_from, goal)
            return path, len(visited)
        new_g = g + 1
        for nxt in neighbors(grid, cell, visited):
            if new_g < best_g.get(nxt, INF):
                best_g[nxt] = new_g
                came_from[nxt] = cell
                nxt_f = new_g + manhattan(nxt, goal)
                heapq.heappush(pq, (nxt_f, new_g, nxt))
    return [], len(visited)


def dijkstra(grid, start, goal):
    """Dijkstra: lấy ra ô có g nhỏ nhất, không dùng heuristic (như A* với h = 0)."""
    pq = [(0, start)]                            # (g, ô)
    best_g = {start: 0}                          # g tốt nhất đã biết của từng ô
    came_from = {}                               # ô -> ô đứng ngay trước nó
    visited = set()                              # các ô đã xét xong
    while pq:
        g, cell = heapq.heappop(pq)
        if cell in visited:
            continue
        visited.add(cell)
        if cell == goal:
            path = build_path(came_from, goal)
            return path, len(visited)
        new_g = g + 1
        for nxt in neighbors(grid, cell, visited):
            if new_g < best_g.get(nxt, INF):
                best_g[nxt] = new_g
                came_from[nxt] = cell
                heapq.heappush(pq, (new_g, nxt))
    return [], len(visited)


def run_astar():
    return a_star(make_grid(), START, GOAL)


def run_dijkstra():
    return dijkstra(make_grid(), START, GOAL)
`;

const START = [9, 4] as const;
const GOAL = [9, 23] as const;

interface Hits {
  /** 1-based source line of the first match at or after `from` */
  line: number;
}

function findLine(source: string[], needle: string, from = 1): Hits {
  for (let i = from - 1; i < source.length; i++) {
    if ((source[i] ?? "").includes(needle)) return { line: i + 1 };
  }
  throw new Error(`Không tìm thấy dòng chứa "${needle}" trong chương trình mẫu`);
}

function lineEventsAt(trace: Trace, line: number): LineEvent[] {
  return trace.steps.filter((s): s is LineEvent => s.ev === "line" && s.line === line);
}

function resultOf(trace: Trace): { pathLen: number; visited: number } {
  const rv = trace.resultValue as { __tuple__?: unknown[] } | undefined;
  const items = rv?.__tuple__;
  if (!Array.isArray(items) || items.length < 2) throw new Error("Kết quả của demo không đúng dạng (đường đi, số ô đã xét)");
  const path = items[0];
  const visited = items[1];
  const pathLen = Array.isArray(path) ? path.length : 0;
  if (typeof visited !== "number") throw new Error("Số ô đã xét không phải số");
  return { pathLen, visited };
}

function cellText(v: unknown): string {
  const items = (v as { __tuple__?: unknown[] } | undefined)?.__tuple__;
  return Array.isArray(items) ? `(${items.join(", ")})` : String(v);
}

interface Algo {
  key: "astar" | "dijkstra";
  fn: "a_star" | "dijkstra";
  call: string;
  title: string;
}

export interface DemoSide {
  title: string;
  visited: number;
  pathCells: number;
  steps: number;
  indexPath: string;
  tracePath: string;
}

export interface DemoResult {
  ok: boolean;
  outDir: string;
  hubPath?: string;
  astar?: DemoSide;
  dijkstra?: DemoSide;
  fewerCells?: number;
  auroraSlides: AuroraSlide[];
  warnings: string[];
  text: string;
}

function narrationFor(source: string[], fnLine: number, algo: Algo): Record<string, string> {
  const n: Record<string, string> = {};
  const set = (needle: string, text: string): void => {
    const l = findLine(source, needle, fnLine).line;
    n[String(l)] = text;
  };
  if (algo.key === "astar") {
    set("pq = [(manhattan(start, goal), 0, start)]", "Hàng đợi ưu tiên bắt đầu chỉ có ô xuất phát. Mỗi phần tử là (f, g, ô) với f = g + h; ở đây g = 0 nên f = h.");
    set("f, g, cell = heapq.heappop(pq)", "Lấy ra ô có f nhỏ nhất. heapq luôn giữ phần tử nhỏ nhất ở đầu danh sách pq.");
  } else {
    set("pq = [(0, start)]", "Hàng đợi ưu tiên bắt đầu chỉ có ô xuất phát, với g = 0. Mỗi phần tử là (g, ô).");
    set("g, cell = heapq.heappop(pq)", "Lấy ra ô có g nhỏ nhất, tức ô gần ô xuất phát nhất trong hàng đợi.");
  }
  set("while pq:", "Còn ô trong hàng đợi thì còn tiếp tục tìm.");
  set("if cell in visited:", "Ô đã xét rồi thì bỏ qua, tránh xét lại.");
  set("visited.add(cell)", "Đánh dấu ô này là đã xét (màu xanh dương trên lưới).");
  set("if cell == goal:", "Đã tới đích chưa? Nếu rồi thì dừng ngay.");
  set("path = build_path(came_from, goal)", "Tới đích: lần ngược theo came_from để dựng đường đi (màu xanh lá).");
  set("new_g = g + 1", "Mỗi ô kề cách ô hiện tại đúng 1 bước nên g của ô kề là g + 1.");
  set("for nxt in neighbors(grid, cell, visited):", "Duyệt từng ô kề chưa xét, không phải tường.");
  set("if new_g < best_g.get(nxt, INF):", "Chỉ nhận ô kề nếu đây là đường ngắn hơn mọi đường đã biết tới nó.");
  set("best_g[nxt] = new_g", "Ghi lại g tốt nhất mới của ô kề.");
  set("came_from[nxt] = cell", "Nhớ ô đứng ngay trước để sau này dựng lại đường đi.");
  if (algo.key === "astar") {
    set("nxt_f = new_g + manhattan(nxt, goal)", "f = g + h: g là quãng đã đi, h là ước lượng quãng còn lại theo khoảng cách Manhattan.");
    set("heapq.heappush(pq, (nxt_f, new_g, nxt))", "Đẩy ô kề vào hàng đợi (màu hổ phách). Ô có f nhỏ nhất sẽ được lấy ra trước.");
  } else {
    set("heapq.heappush(pq, (new_g, nxt))", "Đẩy ô kề vào hàng đợi (màu hổ phách). Ô có g nhỏ nhất sẽ được lấy ra trước.");
  }
  return n;
}

export async function buildDemo(outDirArg?: string): Promise<DemoResult> {
  const outDir = resolve(outDirArg ?? join(tmpdir(), "mira-demo"));
  await mkdir(outDir, { recursive: true });
  const programPath = join(outDir, "grid_search.py");
  await atomicWriteFile(programPath, GRID_SEARCH_PY);
  const warnings: string[] = [];

  const algos: Algo[] = [
    { key: "astar", fn: "a_star", call: "run_astar()", title: "A* trên lưới 18×28" },
    { key: "dijkstra", fn: "dijkstra", call: "run_dijkstra()", title: "Dijkstra trên lưới 18×28" },
  ];
  const traces = new Map<string, { trace: Trace; tracePath: string }>();
  for (const a of algos) {
    const rec = await recordTrace({
      file: programPath,
      call: a.call,
      focus: [a.fn],
      out_dir: join(outDir, a.key),
      max_steps: 5000,
      timeout_sec: 90,
      name: a.title,
    });
    if (!rec.trace || !rec.tracePath) return { ok: false, outDir, auroraSlides: [], warnings, text: `Không ghi được vết ${a.key}: ${rec.text}` };
    if (rec.trace.truncated) warnings.push(`Vết ${a.key} bị cắt ở max_steps: số liệu so sánh lấy từ kết quả chương trình.`);
    traces.set(a.key, { trace: rec.trace, tracePath: rec.tracePath });
  }
  const ta = traces.get("astar") as { trace: Trace; tracePath: string };
  const td = traces.get("dijkstra") as { trace: Trace; tracePath: string };
  const ra = resultOf(ta.trace);
  const rd = resultOf(td.trace);
  const fewer = rd.visited - ra.visited;

  const builds = new Map<string, BuildResult>();
  for (const a of algos) {
    const { trace, tracePath } = traces.get(a.key) as { trace: Trace; tracePath: string };
    const src = trace.source;
    const fnLine = findLine(src, `def ${a.fn}(`).line;
    const popNeedle = a.key === "astar" ? "f, g, cell = heapq.heappop(pq)" : "g, cell = heapq.heappop(pq)";
    const popLine = findLine(src, popNeedle, fnLine).line;
    const pathLine = findLine(src, "path = build_path(came_from, goal)", fnLine).line;
    const mine = a.key === "astar" ? ra : rd;
    const other = a.key === "astar" ? rd : ra;
    const stops: NonNullable<BuildSpecInput["stops"]> = [];

    if (a.key === "astar") {
      stops.push({
        at: { line: popLine, hit: 6 },
        ask: `Hàng đợi \`pq\` giữ các ô theo f = g + h. Sau khi dòng ${popLine} chạy lần thứ 6, \`cell\` là ô nào?`,
        expect: { expr: "cell" },
        explain: "heapq giữ phần tử nhỏ nhất ở đầu danh sách, nên ô lấy ra là phần tử đầu của pq (f nhỏ nhất, hoà thì g nhỏ hơn).",
      });
      const fLine = findLine(src, "nxt_f = new_g + manhattan(nxt, goal)", fnLine).line;
      const fEvents = lineEventsAt(trace, fLine);
      const hit = Math.min(30, fEvents.length);
      const ev = fEvents[hit - 1];
      if (ev) {
        const nxt = ev.locals.nxt;
        const newG = ev.locals.new_g;
        const nr = Number((nxt as { __tuple__: number[] }).__tuple__[0]);
        const nc = Number((nxt as { __tuple__: number[] }).__tuple__[1]);
        const h = Math.abs(GOAL[0] - nr) + Math.abs(GOAL[1] - nc);
        stops.push({
          at: { line: fLine, hit },
          ask: `Ô \`nxt\` = ${cellText(nxt)} có \`new_g\` = ${String(newG)}. Đích là (${GOAL[0]}, ${GOAL[1]}). Sau khi dòng ${fLine} chạy, \`nxt_f\` = g + h bằng bao nhiêu?`,
          expect: { expr: "nxt_f" },
          explain: `h là khoảng cách Manhattan tới đích: |${GOAL[0]} - ${nr}| + |${GOAL[1]} - ${nc}| = ${h}. Vậy f = ${String(newG)} + ${h} = ${Number(newG) + h}.`,
        });
      }
      stops.push({
        at: { line: pathLine },
        ask: `A* vừa tới đích. Sau khi dòng ${pathLine} chạy, \`len(path)\` (số ô trên đường đi, gồm cả hai đầu) bằng bao nhiêu?`,
        expect: { expr: "len(path)" },
        explain: `Khoảng cách Manhattan từ xuất phát tới đích là ${Math.abs(GOAL[0] - START[0]) + Math.abs(GOAL[1] - START[1])}, cộng đường vòng quanh tường. Đường đi có ${mine.pathLen} ô, tức ${mine.pathLen - 1} bước.`,
      });
    } else {
      const firstPop = popLine;
      stops.push({
        at: { line: firstPop },
        ask: `Trên cùng lưới này, A* đã xét ${other.visited} ô khi tới đích. Dijkstra (không có heuristic) sẽ xét số ô nhiều hơn, ít hơn hay bằng A*?`,
        expect: { choice: ["Nhiều hơn A*", "Ít hơn A*", "Bằng A*"], answer: mine.visited > other.visited ? 0 : mine.visited < other.visited ? 1 : 2 },
        explain: `Dijkstra xét ${mine.visited} ô, A* xét ${other.visited} ô. Không có h, Dijkstra mở rộng đều mọi hướng như vòng sóng; A* bị h kéo về phía đích.`,
      });
      stops.push({
        at: { line: popLine, hit: 25 },
        ask: `Sau khi dòng ${popLine} chạy lần thứ 25, \`cell\` là ô nào? (pq là heap theo (g, ô), hoà g thì so tới ô)`,
        expect: { expr: "cell" },
        explain: "Tuple so sánh từng phần tử từ trái sang phải: g nhỏ nhất trước, nếu g bằng nhau thì so hàng rồi cột của ô.",
      });
      stops.push({
        at: { line: pathLine },
        ask: `Đường đi Dijkstra tìm được so với đường đi của A* (${ra.pathLen} ô) thì dài hơn, ngắn hơn hay bằng?`,
        expect: { choice: ["Dài hơn", "Ngắn hơn", "Bằng nhau"], answer: mine.pathLen > ra.pathLen ? 0 : mine.pathLen < ra.pathLen ? 1 : 2 },
        explain: `Cả hai đều cho đường ngắn nhất (${mine.pathLen} ô). Heuristic Manhattan không bao giờ đánh giá quá cao nên A* vẫn tối ưu mà xét ít ô hơn.`,
      });
    }

    const spec: BuildSpecInput = {
      title: a.title,
      subtitle: a.call,
      course: "Mira demo",
      lesson: a.key === "astar" ? "A*" : "Dijkstra",
      trace: tracePath,
      out_dir: join(outDir, a.key),
      theme: "dark",
      viz: [
        {
          kind: "grid",
          var: "grid",
          visited: "visited",
          frontier: "pq",
          path: "path",
          current: "cell",
          start: [START[0], START[1]],
          goal: [GOAL[0], GOAL[1]],
          title: a.key === "astar" ? "Lưới tìm đường (A*)" : "Lưới tìm đường (Dijkstra)",
        },
      ],
      counters: [
        { label: "ĐÃ XÉT", expr: "len(visited)" },
        { label: "TRONG HÀNG ĐỢI", expr: "len(pq)" },
        { label: "g CỦA Ô", expr: "g" },
      ],
      stops,
      narration: narrationFor(src, fnLine, a),
      autoplay_ms: 450,
    };
    const built = await buildPlayer(spec);
    if (!built.ok || !built.indexPath) return { ok: false, outDir, auroraSlides: [], warnings, text: `Không tạo được player ${a.key}:\n${built.text}` };
    for (const w of built.warnings) warnings.push(`${a.key}: ${w}`);
    builds.set(a.key, built);
  }

  const ba = builds.get("astar") as BuildResult;
  const bd = builds.get("dijkstra") as BuildResult;
  const astar: DemoSide = { title: algos[0]!.title, visited: ra.visited, pathCells: ra.pathLen, steps: ba.steps ?? 0, indexPath: ba.indexPath as string, tracePath: ta.tracePath };
  const dijkstra: DemoSide = { title: algos[1]!.title, visited: rd.visited, pathCells: rd.pathLen, steps: bd.steps ?? 0, indexPath: bd.indexPath as string, tracePath: td.tracePath };

  const hubPath = join(outDir, "index.html");
  await atomicWriteFile(hubPath, renderHub(astar, dijkstra));
  notifySmartDrive(outDir);

  const pct = rd.visited > 0 ? Math.round((fewer / rd.visited) * 100) : 0;
  const lines = [
    `# Demo A* và Dijkstra: ${hubPath}`,
    `- Chương trình mẫu: ${programPath}`,
    `- A*: xét ${ra.visited} ô, đường đi ${ra.pathLen} ô, ${astar.steps} bước -> ${astar.indexPath}`,
    `- Dijkstra: xét ${rd.visited} ô, đường đi ${rd.pathLen} ô, ${dijkstra.steps} bước -> ${dijkstra.indexPath}`,
    `- A* xét ít hơn Dijkstra ${fewer} ô (${pct}%).`,
    ...warnings.map((w) => `- Cảnh báo: ${w}`),
  ];
  return { ok: true, outDir, hubPath, astar, dijkstra, fewerCells: fewer, auroraSlides: [ba.auroraSlide, bd.auroraSlide].filter((x): x is AuroraSlide => Boolean(x)), warnings, text: lines.join("\n") };
}

/* ───────── hub page ───────── */

const HUB_CSS = `
body{display:block;overflow:auto}
.hub{max-width:980px;margin:0 auto;padding:44px 24px 56px}
.hub h1{font-size:30px;line-height:1.2;font-weight:600;letter-spacing:-.02em;margin:0 0 8px}
.hub .lead{color:var(--muted);max-width:640px;margin:0 0 34px;font-size:15px}
.hub .verdict{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:0 0 26px}
.hub .verdict b{font-size:44px;letter-spacing:-.03em;color:var(--accent);font-variant-numeric:tabular-nums;font-weight:600}
.hub .verdict span{color:var(--muted);font-size:15px}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
.card{display:flex;flex-direction:column;gap:16px;padding:22px 22px 20px;border-radius:18px;background:var(--panel);border:1px solid var(--border);text-decoration:none;color:var(--text);transition:border-color .18s ease,transform .18s ease}
.card:hover{border-color:rgba(var(--accent-rgb),.6);transform:translateY(-2px)}
.card h2{margin:0;font-size:18px;font-weight:600}
.card .num{font-size:52px;line-height:1;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.card .lab{font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.card .row{display:flex;gap:28px;flex-wrap:wrap}
.bar{height:10px;border-radius:6px;background:var(--cell);overflow:hidden}
.bar i{display:block;height:100%;border-radius:6px}
.bar.a i{background:var(--accent)}
.bar.d i{background:var(--blue)}
.card .go{margin-top:auto;color:var(--accent);font-weight:600;font-size:14px}
.note{margin:28px 0 0;color:var(--faint);font-size:12.5px}
@media (max-width:700px){.cards{grid-template-columns:1fr}.hub{padding:28px 16px 40px}.hub h1{font-size:24px}.hub .verdict b{font-size:36px}}
`;

function renderHub(a: DemoSide, d: DemoSide): string {
  const fewer = d.visited - a.visited;
  const max = Math.max(a.visited, d.visited, 1);
  const pct = d.visited > 0 ? Math.round((fewer / d.visited) * 100) : 0;
  const card = (cls: "a" | "d", side: DemoSide, href: string, label: string): string => `
<a class="card" href="${esc(href)}">
  <h2>${esc(label)}</h2>
  <div><div class="lab">Số ô đã xét</div><div class="num">${side.visited}</div></div>
  <div class="bar ${cls}"><i style="width:${((side.visited / max) * 100).toFixed(1)}%"></i></div>
  <div class="row"><div><div class="lab">Đường đi</div><div>${side.pathCells} ô</div></div><div><div class="lab">Số bước phát lại</div><div>${side.steps}</div></div></div>
  <span class="go">Mở trình dò từng dòng</span>
</a>`;
  return `<!doctype html>
<html lang="vi" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="mira-mcp ${VERSION}">
<meta name="color-scheme" content="dark light">
<title>A* và Dijkstra - Mira</title>
<style>${playerCss}${HUB_CSS}</style>
</head>
<body>
<main class="hub">
  <h1>A* xét ít ô hơn Dijkstra bao nhiêu?</h1>
  <p class="lead">Cùng một lưới 18×28 có ba đoạn tường, cùng ô xuất phát và đích. Hai thuật toán đều tìm được đường ngắn nhất; chỉ khác số ô phải xét. Mở từng trình dò, đoán trước ở các điểm dừng rồi so với kết quả thật.</p>
  <div class="verdict"><b>${fewer}</b><span>ô ít hơn (${pct}%) mà vẫn cùng đường đi ${a.pathCells} ô</span></div>
  <div class="cards">${card("a", a, "astar/index.html", "A*")}${card("d", d, "dijkstra/index.html", "Dijkstra")}</div>
  <p class="note">Tạo bởi Mira ${VERSION}. Số liệu lấy từ hai lần chạy thật của grid_search.py; không có bước nào được dựng sẵn.</p>
</main>
</body>
</html>
`;
}

