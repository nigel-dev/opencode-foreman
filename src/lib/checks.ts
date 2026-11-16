import { spawn } from "node:child_process";

export interface CheckFailure {
  readonly command: string;
  /** Exit code, or `timeout` when the command was killed for running too long. */
  readonly status: number | "timeout" | "error";
  readonly output: string;
}

export interface CheckResult {
  readonly passed: readonly string[];
  /** The first command that failed; later commands are not run. */
  readonly failure: CheckFailure | undefined;
  /** The run was stopped before it finished; nothing should be concluded from it. */
  readonly cancelled: boolean;
}

export type CheckStatus = number | "timeout" | "error" | "cancelled";

export type CheckRunner = (command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ status: CheckStatus; output: string }>;

export interface CheckProgress {
  readonly command: string;
  readonly index: number;
  readonly total: number;
}

export interface CheckOptions {
  readonly signal?: AbortSignal | undefined;
  readonly runner?: CheckRunner | undefined;
  /** Called as each command starts. */
  readonly onStart?: ((progress: CheckProgress) => void) | undefined;
}

const OUTPUT_LIMIT = 6_000;

function tail(value: string): string {
  return value.length <= OUTPUT_LIMIT ? value : `…${value.slice(-OUTPUT_LIMIT)}`;
}

export const shellRunner: CheckRunner = (command, cwd, timeoutMs, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ status: "cancelled", output: "" });
      return;
    }
    let output = "";
    let settled = false;
    // The shell leads its own process group, so the timeout and cancellation reach everything it started.
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone, or the platform has no process groups; fall back to the shell itself.
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => {
      killGroup();
      finish("cancelled");
    };
    const finish = (status: CheckStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ status, output: tail(output.trim()) });
    };
    const collect = (chunk: Buffer) => {
      output = tail(output + chunk.toString("utf8"));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      killGroup();
      finish("timeout");
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish("error");
    });
    child.on("close", (code) => finish(code ?? "error"));
  });

/** Runs the commands in order and stops at the first failure, like a CI job. */
export async function runChecks(commands: readonly string[], cwd: string, timeoutMs: number, options: CheckOptions = {}): Promise<CheckResult> {
  const runner = options.runner ?? shellRunner;
  const passed: string[] = [];
  for (const [index, command] of commands.entries()) {
    if (options.signal?.aborted) return { passed, failure: undefined, cancelled: true };
    options.onStart?.({ command, index, total: commands.length });
    const result = await runner(command, cwd, timeoutMs, options.signal);
    if (result.status === "cancelled") return { passed, failure: undefined, cancelled: true };
    if (result.status !== 0) return { passed, failure: { command, status: result.status, output: result.output }, cancelled: false };
    passed.push(command);
  }
  return { passed, failure: undefined, cancelled: false };
}
