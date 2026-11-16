import { AsyncLocalStorage } from "node:async_hooks";
import type { Answers, Decider } from "./jev.js";

interface Trace {
  answers: Answers | undefined;
  elapsedMs: number | undefined;
}

const scope = new AsyncLocalStorage<Trace>();

/** Wraps a decider so the answers behind a gate's verdict can be read back by whoever started the trace. */
export function traced(decider: Decider): Decider {
  return {
    async ask(state, questions) {
      const started = performance.now();
      const answers = await decider.ask(state, questions);
      const trace = scope.getStore();
      if (trace) {
        trace.answers = answers;
        trace.elapsedMs = Math.round(performance.now() - started);
      }
      return answers;
    },
  };
}

/** Runs one gate invocation and returns its result with the decision-model answers it used, if it asked. */
export async function withTrace<Result>(run: () => Promise<Result>): Promise<{ result: Result } & Trace> {
  const trace: Trace = { answers: undefined, elapsedMs: undefined };
  const result = await scope.run(trace, run);
  return { result, ...trace };
}
