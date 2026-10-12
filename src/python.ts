import { execFileSync, spawn, spawnSync } from "node:child_process";
import { errMsg } from "./util.js";

export interface PythonCmd {
  cmd: string;
  args: string[];
  label: string;
  version: string;
}

let cached: PythonCmd | undefined;
let cachedKey = "";

function probe(cmd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync(cmd, [...args, "-c", "import sys; print(sys.version_info[0], sys.version.split()[0])"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (r.status !== 0) return undefined;
    const m = /^3 (\S+)/.exec(String(r.stdout).trim());
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** MIRA_PYTHON -> `python` on PATH -> `py -3`. Throws a clear Vietnamese error when none works. */
export function resolvePython(): PythonCmd {
  const key = `${process.env.MIRA_PYTHON ?? ""}|${process.env.PATH ?? ""}`;
  if (cached && cachedKey === key) return cached;

  const fromEnv = process.env.MIRA_PYTHON?.trim();
  if (fromEnv) {
    const version = probe(fromEnv, []);
    if (!version) {
      throw new Error(`MIRA_PYTHON="${fromEnv}" không chạy được Python 3. Kiểm tra lại đường dẫn tới python.exe.`);
    }
    cached = { cmd: fromEnv, args: [], label: fromEnv, version };
    cachedKey = key;
    return cached;
  }

  const candidates: Array<{ cmd: string; args: string[]; label: string }> = [{ cmd: "python", args: [], label: "python" }];
  if (process.platform === "win32") candidates.push({ cmd: "py", args: ["-3"], label: "py -3" });
  else candidates.push({ cmd: "python3", args: [], label: "python3" });
  for (const c of candidates) {
    const version = probe(c.cmd, c.args);
    if (version) {
      cached = { ...c, version };
      cachedKey = key;
      return cached;
    }
  }
  throw new Error(
    "Không tìm thấy Python 3. Đặt biến môi trường MIRA_PYTHON trỏ tới python.exe, hoặc cài Python 3 và thêm vào PATH (hoặc dùng py -3).",
  );
}

export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Kills a process and all its children (taskkill /T /F on Windows). */
export function killTree(pid: number | undefined, fallback?: () => void): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // already gone
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        fallback?.();
      } catch {
        // ignore
      }
    }
  }
}

const CAP_BYTES = 256 * 1024;

/** Runs a command with a time box; the whole process tree is killed on timeout. Output is capped. */
export function runProcessWithTimeout(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string },
): Promise<ProcessOutcome> {
  const start = Date.now();
  return new Promise<ProcessOutcome>((resolvePromise) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (e) {
      resolvePromise({ exitCode: 1, stdout: "", stderr: errMsg(e), timedOut: false, durationMs: Date.now() - start });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, () => child.kill("SIGKILL"));
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < CAP_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < CAP_BYTES) stderr += chunk.toString("utf8");
    });

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - start });
    };
    child.on("close", (code) => finalize(code));
    child.on("error", (err) => {
      stderr += `\n${errMsg(err)}`;
      finalize(1);
    });
  });
}
