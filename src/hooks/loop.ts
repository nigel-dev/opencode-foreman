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
  constructor(tool: string, repeats: number) {
    super(
      `Foreman blocked this call: \`${tool}\` has already run ${repeats} times in a row with exactly these arguments, so running it again will give the same result. ` +
        "Do something different: change the arguments, try another approach, or tell the user what is blocking you.",
    );
    this.name = "RepeatedCallError";
  }
}

/**
 * Counts consecutive identical tool calls per session and throws once the limit is passed. Any
 * different call in between resets the count, so re-running a check after an edit is unaffected.
 */
export function createLoopGuard(config: LoopGuardConfig): (event: ToolCallEvent) => void {
  const last = new BoundedMap<string, { fingerprint: string; count: number }>();
  const ignored = new Set(config.ignore);

  return (event) => {
    if (ignored.has(event.tool)) return;
    const current = fingerprint(event);
    const previous = last.get(event.sessionID);
    const count = previous?.fingerprint === current ? previous.count + 1 : 1;
    last.set(event.sessionID, { fingerprint: current, count });
    if (count > config.maxRepeats) throw new RepeatedCallError(event.tool, config.maxRepeats);
  };
}
