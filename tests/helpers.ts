import type { Answer, Answers, Decider, Question } from "../src/lib/jev.js";

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
