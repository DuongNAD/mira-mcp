/**
 * SmartDrive post-write hook (ecosystem contract "post-write-hook"): after Mira writes outputs into a folder on the
 * SmartDrive drive, fire `smart-drive update <dir> --quiet` in the background so the index stays fresh.
 * Best effort, non-blocking, failures ignored, coalesced per folder within 2 seconds.
 *
 *   MIRA_SMARTDRIVE=off|false|0|no   disable (SMARTDRIVE_HOOK=off is honoured too)
 *   MIRA_SMARTDRIVE_CMD="<command>"  override the command line (tokens split on spaces, quotes allowed)
 *   MIRA_SMARTDRIVE_ROOT="D:"        drive/root of the SmartDrive volume (default D:); outputs elsewhere are skipped
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Splits a command line into tokens, preserving quoted arguments. */
export function splitCommand(cmdStr: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inQuote: "'" | '"' | null = null;
  for (let i = 0; i < cmdStr.length; i++) {
    const ch = cmdStr[i]!;
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

export function isSmartDriveDisabled(): boolean {
  for (const name of ["MIRA_SMARTDRIVE", "SMARTDRIVE_HOOK"]) {
    const val = process.env[name]?.trim().toLowerCase();
    if (val === "off" || val === "false" || val === "0" || val === "no") return true;
  }
  return false;
}

const exeCache = new Map<string, string | null>();

export function findExecutable(candidates: string[]): string | undefined {
  const cacheKey = `${candidates.join("|")}|${process.env.PATH ?? ""}`;
  if (exeCache.has(cacheKey)) return exeCache.get(cacheKey) ?? undefined;
  const isWin = process.platform === "win32";
  const dirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
  for (const cand of candidates) {
    for (const dir of dirs) {
      const p = join(dir, cand);
      const options = isWin && !/\.(exe|cmd|bat)$/i.test(cand) ? [`${p}.exe`, `${p}.cmd`, `${p}.bat`, p] : [p];
      for (const o of options) {
        if (existsSync(o)) {
          exeCache.set(cacheKey, o);
          return o;
        }
      }
    }
  }
  exeCache.set(cacheKey, null);
  return undefined;
}

export function resolveSmartDriveCommand(): { executable: string; baseArgs: string[] } | undefined {
  const override = process.env.MIRA_SMARTDRIVE_CMD?.trim();
  if (override) {
    const parts = splitCommand(override);
    if (parts.length > 0) return { executable: parts[0]!, baseArgs: parts.slice(1) };
  }
  const sd = findExecutable(["smart-drive"]);
  if (sd) return { executable: sd, baseArgs: [] };
  if (process.platform === "win32") {
    const py = findExecutable(["py"]);
    if (py) return { executable: py, baseArgs: ["-3", "-m", "smart_drive"] };
    const python = findExecutable(["python", "python3"]);
    if (python) return { executable: python, baseArgs: ["-m", "smart_drive"] };
  } else {
    const python = findExecutable(["python3", "python"]);
    if (python) return { executable: python, baseArgs: ["-m", "smart_drive"] };
  }
  return undefined;
}

/** True when the folder lives on the SmartDrive volume (default drive D:). */
export function onSmartDriveVolume(dir: string): boolean {
  const abs = resolve(dir);
  const root = (process.env.MIRA_SMARTDRIVE_ROOT?.trim() || (process.platform === "win32" ? "D:" : "")).replace(/[\\/]+$/, "");
  if (!root) return false;
  if (process.platform === "win32") return abs.slice(0, root.length).toLowerCase() === root.toLowerCase();
  return abs === root || abs.startsWith(`${root}/`);
}

interface FolderState {
  lastSpawnTime: number;
  timer: NodeJS.Timeout | null;
  trailingRequested: boolean;
}

const folderStates = new Map<string, FolderState>();
let hasLoggedFailure = false;

export function _resetSmartDriveState(): void {
  for (const s of folderStates.values()) if (s.timer) clearTimeout(s.timer);
  folderStates.clear();
  hasLoggedFailure = false;
}

function executeNotify(normDir: string): void {
  const cmd = resolveSmartDriveCommand();
  if (!cmd) return;
  const args = [...cmd.baseArgs, "update", normDir, "--quiet"];
  try {
    const child = spawn(cmd.executable, args, { detached: true, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      try {
        if (child.pid && !child.killed) child.kill();
      } catch {
        // ignore
      }
    }, 60_000);
    timer.unref();
    child.on("exit", () => clearTimeout(timer));
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!hasLoggedFailure) {
        hasLoggedFailure = true;
        console.error(`[mira] SmartDrive notification error: ${err.message}`);
      }
    });
    child.unref();
  } catch (err) {
    if (!hasLoggedFailure) {
      hasLoggedFailure = true;
      console.error(`[mira] SmartDrive spawn error: ${(err as Error).message}`);
    }
  }
}

/**
 * Best-effort, non-blocking notification to SmartDrive that `dir` changed.
 * Returns true when a notification was scheduled (useful for tests); false when skipped.
 */
export function notifySmartDrive(dir: string): boolean {
  if (isSmartDriveDisabled()) return false;
  if (!onSmartDriveVolume(dir)) return false;
  const normDir = resolve(dir);
  const now = Date.now();
  const state = folderStates.get(normDir);
  if (!state || now - state.lastSpawnTime >= 2000) {
    if (state?.timer) clearTimeout(state.timer);
    folderStates.set(normDir, { lastSpawnTime: now, timer: null, trailingRequested: false });
    executeNotify(normDir);
  } else {
    state.trailingRequested = true;
    if (!state.timer) {
      const delay = Math.max(50, 2000 - (now - state.lastSpawnTime));
      state.timer = setTimeout(() => {
        const cur = folderStates.get(normDir);
        if (cur && cur.trailingRequested) {
          cur.lastSpawnTime = Date.now();
          cur.trailingRequested = false;
          cur.timer = null;
          executeNotify(normDir);
        } else if (cur) {
          cur.timer = null;
        }
      }, delay);
      state.timer.unref();
    }
  }
  return true;
}
