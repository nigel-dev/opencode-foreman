import type { LoopGuardConfig } from "../lib/config.js";
import { BoundedMap } from "../lib/sessions.js";

export interface ToolCallEvent {
  readonly sessionID: string;
  readonly tool: string;
  readonly input: unknown;
}

/** JSON with object keys sorted, so the same arguments in a different order give the same fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function fingerprint(event: Pick<ToolCallEvent, "tool" | "input">): string {
  return `${event.tool}:${canonical(event.input)}`;
}

export class RepeatedCallError extends Error {
  constructor(
    readonly tool: string,
    readonly cycle: number,
    repeats: number,
  ) {
    super(
      (cycle === 1
        ? `Foreman blocked this call: \`${tool}\` has already run ${repeats} times in a row with exactly these arguments, so running it again will give the same result. `
        : `Foreman blocked this call: the last ${cycle} tool calls have repeated ${repeats} times in the same order with the same arguments, so going round again will give the same results. `) +
        "Do something different: change the arguments, try another approach, or tell the user what is blocking you.",
    );
    this.name = "RepeatedCallError";
  }
}

const MAX_CYCLE = 3;

/** The shortest cycle length (1 to 3 calls) that the tail of the history has repeated more than `maxRepeats` times. */
export function repeatingCycle(history: readonly string[], maxRepeats: number): number | undefined {
  for (let cycle = 1; cycle <= MAX_CYCLE; cycle++) {
    const needed = cycle * (maxRepeats + 1);
    if (history.length < needed) continue;
    const start = history.length - needed;
    let periodic = true;
    for (let index = start + cycle; index < history.length; index++) {
      if (history[index] !== history[index - cycle]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return cycle;
  }
  return undefined;
}

/**
 * Remembers each session's recent tool calls and throws when the same call, or the same short cycle of
 * calls, has repeated more than `maxRepeats` times. Any different call breaks the pattern, so re-running
 * a check after an edit is unaffected.
 */
export function createLoopGuard(config: LoopGuardConfig): (event: ToolCallEvent) => void {
  const histories = new BoundedMap<string, string[]>();
  const ignored = new Set(config.ignore);
  const keep = MAX_CYCLE * (config.maxRepeats + 1);

  return (event) => {
    if (ignored.has(event.tool)) return;
    const history = histories.get(event.sessionID) ?? [];
    history.push(fingerprint(event));
    if (history.length > keep) history.splice(0, history.length - keep);
    histories.set(event.sessionID, history);
    const cycle = repeatingCycle(history, config.maxRepeats);
    if (cycle !== undefined) throw new RepeatedCallError(event.tool, cycle, config.maxRepeats);
  };
}
