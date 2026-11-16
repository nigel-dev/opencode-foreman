import type { JevConfig } from "./config.js";

export type Question =
  | { readonly type: "noul"; readonly instructions: string; readonly criteria?: { readonly true: string; readonly false: string } }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly string[] };

export type Answer =
  | { readonly type: "noul"; readonly probability: number }
  | { readonly type: "choice"; readonly choice: string; readonly confidence: number }
  | { readonly type: "score"; readonly score: number; readonly confidence: number };

export type Answers = Readonly<Record<string, Answer>>;

export interface Decider {
  /** Resolves to `undefined` when the decision model is unreachable or returns an unusable response. */
  ask(state: unknown, questions: Readonly<Record<string, Question>>): Promise<Answers | undefined>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unit(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : undefined;
}

function parseAnswer(value: unknown): Answer | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "noul") {
    const probability = unit(value.noul);
    return probability === undefined ? undefined : { type: "noul", probability };
  }
  const confidence = unit(value.confidence);
  if (confidence === undefined) return undefined;
  if (value.type === "choice" && typeof value.choice === "string") {
    return { type: "choice", choice: value.choice, confidence };
  }
  if (value.type === "score" && typeof value.score === "number" && Number.isFinite(value.score)) {
    return { type: "score", score: value.score, confidence };
  }
  return undefined;
}

export function parseAnswers(body: unknown, names: readonly string[]): Answers | undefined {
  if (!isRecord(body) || !isRecord(body.answers)) return undefined;
  const answers: Record<string, Answer> = {};
  for (const name of names) {
    const answer = parseAnswer(body.answers[name]);
    if (!answer) return undefined;
    answers[name] = answer;
  }
  return answers;
}

export function createJevDecider(config: JevConfig, fetchImpl: Fetch = fetch): Decider | undefined {
  const { apiKey } = config;
  if (!apiKey) return undefined;
  return {
    async ask(state, questions) {
      try {
        const response = await fetchImpl(config.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: config.model, state, questions }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (!response.ok) return undefined;
        return parseAnswers(await response.json(), Object.keys(questions));
      } catch {
        // Every gate treats a missing decision as "do nothing", so an outage never blocks a session.
        return undefined;
      }
    },
  };
}

export function probability(answers: Answers, name: string): number | undefined {
  const answer = answers[name];
  return answer?.type === "noul" ? answer.probability : undefined;
}
