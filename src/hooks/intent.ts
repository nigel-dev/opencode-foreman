import { INTENTS, type Intent, type IntentGateConfig } from "../lib/config.js";
import { probability, type Answers, type Decider, type Question } from "../lib/jev.js";
import { BoundedMap, head } from "../lib/sessions.js";

const COMPLEXITY = ["small", "moderate", "large"] as const;

export const QUESTIONS = {
  intent: {
    type: "choice",
    instructions: "What kind of work is this request?",
    criteria: {
      trivial: "A tiny change the assistant can make immediately: a typo, a rename, a one-line or single-file fix",
      explore: "Finding or explaining something in the existing codebase, with no changes",
      implement: "Building, fixing, or refactoring code or configuration",
      plan: "Designing an approach or writing a plan before any changes are made",
      research: "Looking up external documentation, libraries, or other sources",
      discuss: "Conversation, opinion, or a question that needs no tools",
    } satisfies Record<Intent, string>,
  },
  complexity: {
    type: "score",
    instructions: "How much work is this request?",
    criteria: [
      "Small: one file or a few lines",
      "Moderate: several files or steps",
      "Large: many steps, cross-cutting changes, or unclear scope",
    ],
  },
  ambiguous: {
    type: "noul",
    instructions: "Is the request too ambiguous to act on without asking the user a clarifying question first?",
  },
} as const satisfies Record<string, Question>;

export interface Routing {
  readonly intent: Intent;
  readonly confidence: number;
  readonly complexity: (typeof COMPLEXITY)[number];
  readonly ambiguous: boolean;
}

function isIntent(value: string): value is Intent {
  return (INTENTS as readonly string[]).includes(value);
}

export function classify(answers: Answers, minConfidence: number): Routing | undefined {
  const intent = answers.intent;
  const complexity = answers.complexity;
  const ambiguous = probability(answers, "ambiguous");
  if (intent?.type !== "choice" || complexity?.type !== "score" || ambiguous === undefined) return undefined;
  if (!isIntent(intent.choice) || intent.confidence < minConfidence) return undefined;
  const level = Math.min(COMPLEXITY.length - 1, Math.max(0, Math.round(complexity.score)));
  return {
    intent: intent.choice,
    confidence: intent.confidence,
    complexity: COMPLEXITY[level] ?? "moderate",
    ambiguous: ambiguous >= 0.5,
  };
}

/** `handling` is left out for agents that work alone, since the suggested handling is about delegating. */
export function renderHint(routing: Routing, handling: string | undefined): string {
  const lines = [
    "## Foreman routing hint",
    "",
    "An automatic classification of the latest user request. It is advisory: the user's explicit instructions always win.",
    "",
    `- Intent: ${routing.intent} (confidence ${routing.confidence.toFixed(2)})`,
    `- Size: ${routing.complexity}`,
  ];
  if (handling) lines.push(`- Suggested handling: ${handling}`);
  if (routing.ambiguous) lines.push("- The request looks ambiguous. Ask a clarifying question before acting.");
  return lines.join("\n");
}

export interface IntentGateDeps {
  readonly config: IntentGateConfig;
  readonly decider: Decider;
  readonly isRoot: (sessionID: string) => Promise<boolean>;
}

export interface PromptEvent {
  readonly sessionID: string;
  readonly prompt: { readonly text: string };
}

export interface ContextEvent {
  readonly sessionID: string;
  readonly agent?: string;
  readonly system: Array<{ type: "text"; text: string }>;
}

export interface IntentGate {
  onPrompt(event: PromptEvent): Promise<Routing | undefined>;
  onContext(event: ContextEvent): void;
  clear(): void;
}

export function createIntentGate(deps: IntentGateDeps): IntentGate {
  const routings = new BoundedMap<string, Routing>();
  const solo = new Set(deps.config.soloAgents);

  return {
    async onPrompt(event) {
      const { sessionID } = event;
      // A new request invalidates the previous classification even when this one cannot be classified.
      routings.delete(sessionID);
      const request = event.prompt.text.trim();
      if (request === "" || !(await deps.isRoot(sessionID))) return undefined;
      const answers = await deps.decider.ask(head(request, 8_000), QUESTIONS);
      const routing = answers && classify(answers, deps.config.minConfidence);
      if (!routing) return undefined;
      routings.set(sessionID, routing);
      return routing;
    },
    onContext(event) {
      const routing = routings.get(event.sessionID);
      if (!routing) return;
      const handling = event.agent !== undefined && solo.has(event.agent) ? undefined : deps.config.routes[routing.intent];
      // Injected per model request rather than written into the prompt, so the stored user message stays untouched.
      event.system.push({ type: "text", text: renderHint(routing, handling) });
    },
    clear() {
      routings.clear();
    },
  };
}
