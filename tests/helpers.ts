import type { Answer, Answers, Decider, Question } from "../src/lib/jev.js";
import { createOperations, type Operation } from "../src/lib/operations.js";
import { createSessionState, type SessionState } from "../src/lib/state.js";

export function noul(probability: number): Answer {
  return { type: "noul", probability };
}

export interface FakeDecider extends Decider {
  readonly calls: Array<{ state: unknown; questions: Readonly<Record<string, Question>> }>;
}

export function fakeDecider(answers: Answers | undefined): FakeDecider {
  const calls: FakeDecider["calls"] = [];
  return {
    calls,
    async ask(state, questions) {
      calls.push({ state, questions });
      return answers;
    },
  };
}

export function user(id: string, text: string) {
  return { type: "user", id, text };
}

export function assistant(text: string, extra: Record<string, unknown> = {}) {
  return { type: "assistant", id: `a-${text.length}`, content: [{ type: "text", text }], finish: "stop", ...extra };
}

export function memoryStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => void data.set(key, value),
    remove: async (key: string) => void data.delete(key),
  };
}

export function memoryState(): SessionState {
  return createSessionState(memoryStorage());
}

/** A live operation, with the means to cancel it the way a Stop would. */
export function liveOperation(sessionID = "ses_1"): { operation: Operation; cancel: () => void } {
  const operations = createOperations();
  return { operation: operations.begin(sessionID), cancel: () => void operations.cancel(sessionID) };
}
