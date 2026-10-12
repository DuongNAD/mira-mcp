import type { VizCfg } from "../types.js";
import { createArray } from "./array.js";
import { VIZ_TITLES, type VizInstance } from "./common.js";
import { createGraph } from "./graph.js";
import { createGrid } from "./grid.js";
import { createPlot } from "./plot.js";
import { createSeq } from "./seq.js";
import { createStatevector } from "./statevector.js";
import { createTable } from "./table.js";

export function createViz(cfg: VizCfg): VizInstance {
  switch (cfg.kind) {
    case "array":
      return createArray(cfg);
    case "grid":
      return createGrid(cfg);
    case "graph":
      return createGraph(cfg);
    case "statevector":
      return createStatevector(cfg);
    case "plot":
      return createPlot(cfg);
    case "table":
      return createTable(cfg);
    case "stack":
    case "queue":
    case "heap":
      return createSeq(cfg);
  }
}

export function vizTitle(cfg: VizCfg): string {
  return cfg.title ?? VIZ_TITLES[cfg.kind] ?? cfg.kind;
}
