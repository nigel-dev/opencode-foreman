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
}

export type CheckRunner = (command: string, cwd: string, timeoutMs: number) => Promise<{ status: CheckFailure["status"] | 0; output: string }>;

const OUTPUT_LIMIT = 6_000;

function tail(value: string): string {
  return value.length <= OUTPUT_LIMIT ? value : `…${value.slice(-OUTPUT_LIMIT)}`;
}

export const shellRunner: CheckRunner = (command, cwd, timeoutMs) =>
  new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (status: CheckFailure["status"] | 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, output: tail(output.trim()) });
    };
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    const collect = (chunk: Buffer) => {
      output = tail(output + chunk.toString("utf8"));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("timeout");
    }, timeoutMs);
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish("error");
    });
    child.on("close", (code) => finish(code ?? "error"));
  });

/** Runs the commands in order and stops at the first failure, like a CI job. */
export async function runChecks(
  commands: readonly string[],
  cwd: string,
  timeoutMs: number,
  runner: CheckRunner = shellRunner,
): Promise<CheckResult> {
  const passed: string[] = [];
  for (const command of commands) {
    const result = await runner(command, cwd, timeoutMs);
    if (result.status !== 0) return { passed, failure: { command, status: result.status, output: result.output } };
    passed.push(command);
  }
  return { passed, failure: undefined };
}
