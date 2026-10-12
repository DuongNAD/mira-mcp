#!/usr/bin/env node
/**
 * Build Mira MCP.
 *
 * node_modules never lives in the project folder: the toolchain is resolved from MIRA_TOOLCHAIN, then
 * ORION_TOOLCHAIN, VEGA_TOOLCHAIN, POLARIS_TOOLCHAIN, or %LOCALAPPDATA%/aurora-slides/toolchain.
 *
 *   node scripts/build.mjs            two-pass bundle -> dist/mira.mjs
 *   node scripts/build.mjs --check    type-check src (node) and src/player (dom lib), then bundle
 *
 * Pass 1 bundles the browser player (src/player/main.ts -> iife, src/player/player.css) in memory.
 * Pass 2 bundles src/index.ts; the plugin below serves `virtual:player-js` and `virtual:player-css`
 * as text modules built by pass 1, so the generated pages are fully self-contained.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base =
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "aurora-slides")
    : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "aurora-slides");

const TOOL = resolve(
  process.env.MIRA_TOOLCHAIN ??
    process.env.ORION_TOOLCHAIN ??
    process.env.VEGA_TOOLCHAIN ??
    process.env.POLARIS_TOOLCHAIN ??
    join(base, "toolchain"),
);
const NM = join(TOOL, "node_modules");
const args = new Set(process.argv.slice(2));
const t0 = Date.now();
const log = (m) => console.log(`[build] ${m}`);

if (!existsSync(join(NM, "esbuild"))) {
  log(`Toolchain not found at ${TOOL}`);
  log("Please set MIRA_TOOLCHAIN to the toolchain directory.");
  process.exit(1);
}

const req = createRequire(join(TOOL, "package.json"));
const esbuild = req("esbuild");
const DIST = join(ROOT, "dist");
mkdirSync(DIST, { recursive: true });

/* ───────── Type-check (node config + player/dom config) ───────── */
if (args.has("--check")) {
  const work = join(TOOL, "check_mira");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(join(ROOT, "src"), join(work, "src"), { recursive: true });
  writeFileSync(join(work, "package.json"), JSON.stringify({ type: "module", private: true }));

  const common = {
    target: "ES2022",
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
  };
  writeFileSync(
    join(work, "tsconfig.node.json"),
    JSON.stringify(
      {
        compilerOptions: {
          ...common,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2023"],
          types: ["node"],
          esModuleInterop: true,
          resolveJsonModule: true,
        },
        include: ["src/**/*.ts"],
        exclude: ["src/player/main.ts", "src/player/ui/**", "src/player/viz/**"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(work, "tsconfig.player.json"),
    JSON.stringify(
      {
        compilerOptions: {
          ...common,
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          types: [],
        },
        include: ["src/player/**/*.ts"],
      },
      null,
      2,
    ),
  );

  let failed = false;
  for (const [label, file] of [
    ["node", "tsconfig.node.json"],
    ["player (dom)", "tsconfig.player.json"],
  ]) {
    log(`type-checking ${label}...`);
    try {
      execFileSync(process.execPath, [join(NM, "typescript", "bin", "tsc"), "-p", join(work, file)], {
        cwd: work,
        stdio: "pipe",
      });
      log(`types OK (${label})`);
    } catch (e) {
      failed = true;
      const out = String(e.stdout ?? "") + String(e.stderr ?? "");
      console.log(out.split(work).join(ROOT).trim());
    }
  }
  if (failed && !args.has("--force")) process.exit(1);
}

/* ───────── Pass 1: browser player (JS + CSS), in memory ───────── */
const WOFF = (pkg, file) => join(NM, pkg, "files", file);
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const VIET =
  "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB";
const FONT_FACES = [
  ["Be Vietnam Pro", "400", "@fontsource/be-vietnam-pro", "be-vietnam-pro-vietnamese-400-normal.woff2", VIET],
  ["Be Vietnam Pro", "400", "@fontsource/be-vietnam-pro", "be-vietnam-pro-latin-400-normal.woff2", LATIN],
  ["Be Vietnam Pro", "600", "@fontsource/be-vietnam-pro", "be-vietnam-pro-vietnamese-600-normal.woff2", VIET],
  ["Be Vietnam Pro", "600", "@fontsource/be-vietnam-pro", "be-vietnam-pro-latin-600-normal.woff2", LATIN],
  ["JetBrains Mono", "100 800", "@fontsource-variable/jetbrains-mono", "jetbrains-mono-vietnamese-wght-normal.woff2", VIET],
  ["JetBrains Mono", "100 800", "@fontsource-variable/jetbrains-mono", "jetbrains-mono-latin-wght-normal.woff2", LATIN],
];

function fontCss() {
  let css = "";
  let used = 0;
  for (const [family, weight, pkg, file, range] of FONT_FACES) {
    const p = WOFF(pkg, file);
    if (!existsSync(p)) continue;
    const b64 = readFileSync(p).toString("base64");
    css += `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weight};src:url(data:font/woff2;base64,${b64}) format("woff2");unicode-range:${range}}`;
    used++;
  }
  log(`fonts inlined: ${used}/${FONT_FACES.length}${used < FONT_FACES.length ? " (system fallbacks cover the rest)" : ""}`);
  return css;
}

const playerJsRes = await esbuild.build({
  entryPoints: [join(ROOT, "src", "player", "main.ts")],
  outfile: join(DIST, "player.js"),
  write: false,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
let playerJs = playerJsRes.outputFiles[0].text;
// Safe to inline inside an HTML <script> element.
playerJs = playerJs.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

const playerCssRes = await esbuild.build({
  entryPoints: [join(ROOT, "src", "player", "player.css")],
  outfile: join(DIST, "player.css"),
  write: false,
  bundle: true,
  minify: true,
  loader: { ".css": "css" },
  legalComments: "none",
  logLevel: "warning",
});
const playerCss = fontCss() + playerCssRes.outputFiles[0].text;
log(`player: js ${(playerJs.length / 1024).toFixed(1)} KB, css+fonts ${(playerCss.length / 1024).toFixed(1)} KB`);

/* ───────── Pass 2: the node bundle with the player embedded ───────── */
const virtualPlayer = {
  name: "mira-virtual-player",
  setup(b) {
    b.onResolve({ filter: /^virtual:player-(js|css)$/ }, (a) => ({ path: a.path, namespace: "mira-virtual" }));
    b.onLoad({ filter: /.*/, namespace: "mira-virtual" }, (a) => ({
      contents: `export default ${JSON.stringify(a.path.endsWith("js") ? playerJs : playerCss)};`,
      loader: "js",
    }));
  },
};

const outFile = join(DIST, "mira.mjs");
await esbuild.build({
  entryPoints: [join(ROOT, "src", "index.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  nodePaths: [NM],
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: "none",
  logLevel: "warning",
  plugins: [virtualPlayer],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __miraCR } from 'node:module';\nconst require = __miraCR(import.meta.url);",
  },
});

const outSize = statSync(outFile).size;
log(`dist/mira.mjs: ${(outSize / 1024).toFixed(1)} KB`);
log(`done in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
