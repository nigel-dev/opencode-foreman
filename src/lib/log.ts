import { appendFile, mkdir, open, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Answers } from "./jev.js";

export interface LogConfig {
  readonly enabled: boolean;
  readonly path: string;
  /** The file is renamed to `<path>.1` once it passes this size, replacing any earlier `.1`. */
  readonly maxBytes: number;
}

/** Follows the XDG data directory, next to OpenCode's own logs. */
export function defaultLogPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(homedir(), ".local", "share");
  return join(data, "opencode", "foreman", "decisions.jsonl");
}

/** Probabilities and choices only, so a log line shows why a gate acted without storing what was said. */
export function flattenAnswers(answers: Answers): Record<string, number | string> {
  const flat: Record<string, number | string> = {};
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type === "noul") flat[name] = answer.probability;
    else if (answer.type === "choice") flat[name] = `${answer.choice}@${answer.confidence}`;
    else flat[name] = answer.score;
  }
  return flat;
}

export interface DecisionLog {
  write(entry: Readonly<Record<string, unknown>>): Promise<void>;
}

// One append queue per file for the whole process, however many plugin instances or config reloads
// write to it, so lines stay whole and two writers never rotate the same file at once.
const QUEUES = Symbol.for("opencode-foreman.log.queues");
function queues(): Map<string, Promise<void>> {
  const holder = globalThis as { [QUEUES]?: Map<string, Promise<void>> };
  return (holder[QUEUES] ??= new Map());
}

async function append(config: LogConfig, line: string): Promise<void> {
  await mkdir(dirname(config.path), { recursive: true });
  const size = await stat(config.path).then(
    (info) => info.size,
    () => 0,
  );
  if (size > config.maxBytes) {
    // Another process may have rotated it first; then there is nothing left to move.
    await rename(config.path, `${config.path}.1`).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    });
  }
  await appendFile(config.path, line, "utf8");
}

export function createDecisionLog(config: LogConfig): DecisionLog {
  let warned = false;
  return {
    write(entry) {
      if (!config.enabled) return Promise.resolve();
      const next = (queues().get(config.path) ?? Promise.resolve())
        .then(() => append(config, `${JSON.stringify(entry)}\n`))
        .catch((error: unknown) => {
          if (warned) return;
          warned = true;
          console.warn(`[foreman] Could not write the decision log at ${config.path}: ${error instanceof Error ? error.message : String(error)}`);
        });
      queues().set(config.path, next);
      return next;
    },
  };
}

const TAIL_BYTES = 256_000;

/**
 * The newest entries in the log, most recent first. Lets the status view survive a plugin reload, which
 * discards everything held in memory. Unreadable files and malformed lines yield nothing.
 */
export async function readRecentEntries(path: string, limit: number): Promise<Record<string, unknown>[]> {
  try {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split("\n");
      // A tail that starts mid-file begins with a partial line.
      if (length < size) lines.shift();
      const entries: Record<string, unknown>[] = [];
      for (let index = lines.length - 1; index >= 0 && entries.length < limit; index--) {
        const line = lines[index];
        if (!line) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) entries.push(parsed as Record<string, unknown>);
        } catch {
          // A line cut short by a crash is skipped.
        }
      }
      return entries;
    } finally {
      await file.close();
    }
  } catch {
    // Fails open: the log is only a convenience for the status view, so a missing or unreadable file shows no history.
    return [];
  }
}
