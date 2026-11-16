import { expect, test } from "bun:test";
import { resolveConfig } from "../../src/lib/config.js";
import { classify, createIntentGate, renderHint } from "../../src/hooks/intent.js";
import type { Answers } from "../../src/lib/jev.js";
import { fakeDecider, noul } from "../helpers.js";

function answers(choice: string, confidence: number, score: number, ambiguous: number): Answers {
  return {
    intent: { type: "choice", choice, confidence },
    complexity: { type: "score", score, confidence: 0.8 },
    ambiguous: noul(ambiguous),
  };
}

const config = resolveConfig({ intentGate: { routes: { implement: "Send it to worker-deep." } } }).intentGate;

test("classify maps answers to a routing and rejects weak or unknown intents", () => {
  expect(classify(answers("implement", 0.9, 1.6, 0.2), 0.5)).toEqual({
    intent: "implement",
    confidence: 0.9,
    complexity: "large",
    ambiguous: false,
  });
  expect(classify(answers("implement", 0.4, 1, 0), 0.5)).toBeUndefined();
  expect(classify(answers("deploy", 0.9, 1, 0), 0.5)).toBeUndefined();
  expect(classify({ intent: noul(1) }, 0.5)).toBeUndefined();
});

test("renderHint uses the configured route and flags ambiguity", () => {
  const hint = renderHint({ intent: "implement", confidence: 0.91, complexity: "moderate", ambiguous: true }, config.routes.implement);
  expect(hint).toContain("Intent: implement (confidence 0.91)");
  expect(hint).toContain("Send it to worker-deep.");
  expect(hint).toContain("Ask a clarifying question");
});

function harness(decided: Answers | undefined, root = true) {
  const decider = fakeDecider(decided);
  const gate = createIntentGate({ config, decider, isRoot: async () => root });
  const systemFor = (sessionID: string) => {
    const event = { sessionID, system: [] as Array<{ type: "text"; text: string }> };
    gate.onContext(event);
    return event.system;
  };
  return { gate, decider, systemFor };
}

test("a classified prompt adds a hint to that session's requests only", async () => {
  const { gate, systemFor } = harness(answers("implement", 0.9, 1, 0));
  await gate.onPrompt({ sessionID: "ses_1", prompt: { text: "Add a dark mode toggle" } });
  expect(systemFor("ses_1")).toHaveLength(1);
  expect(systemFor("ses_1")[0]?.text).toContain("Send it to worker-deep.");
  expect(systemFor("ses_2")).toEqual([]);
});

test("a prompt that cannot be classified clears the previous hint", async () => {
  const decider = fakeDecider(answers("implement", 0.9, 1, 0));
  let decided: Answers | undefined = answers("implement", 0.9, 1, 0);
  const gate = createIntentGate({
    config,
    decider: { ask: async (state, questions) => (await decider.ask(state, questions), decided) },
    isRoot: async () => true,
  });
  const system = () => {
    const event = { sessionID: "ses_1", system: [] as Array<{ type: "text"; text: string }> };
    gate.onContext(event);
    return event.system;
  };
  await gate.onPrompt({ sessionID: "ses_1", prompt: { text: "Build it" } });
  expect(system()).toHaveLength(1);
  decided = undefined;
  await gate.onPrompt({ sessionID: "ses_1", prompt: { text: "ok" } });
  expect(system()).toEqual([]);
});

test("empty prompts and child sessions are not classified", async () => {
  const empty = harness(answers("implement", 0.9, 1, 0));
  await empty.gate.onPrompt({ sessionID: "ses_1", prompt: { text: "   " } });
  expect(empty.decider.calls).toHaveLength(0);

  const child = harness(answers("implement", 0.9, 1, 0), false);
  await child.gate.onPrompt({ sessionID: "ses_1", prompt: { text: "Build it" } });
  expect(child.decider.calls).toHaveLength(0);
  expect(child.systemFor("ses_1")).toEqual([]);
});

test("agents that work alone get the classification without the delegation advice", async () => {
  const gate = createIntentGate({ config: resolveConfig({}, {}).intentGate, decider: fakeDecider(answers("implement", 0.9, 1, 0)), isRoot: async () => true });
  await gate.onPrompt({ sessionID: "ses_1", prompt: { text: "Add a dark mode toggle" } });
  const systemFor = (agent: string) => {
    const event = { sessionID: "ses_1", agent, system: [] as Array<{ type: "text"; text: string }> };
    gate.onContext(event);
    return event.system[0]?.text ?? "";
  };
  expect(systemFor("orchestrator")).toContain("Suggested handling");
  expect(systemFor("deep")).toContain("Intent: implement");
  expect(systemFor("deep")).not.toContain("Suggested handling");
  expect(systemFor("planner")).not.toContain("Suggested handling");
});

test("a route that names a disabled agent falls back to generic wording", () => {
  const routes = resolveConfig({ agents: { librarian: { disabled: true }, "worker-deep": { disabled: true } } }, {}).intentGate.routes;
  expect(routes.research).not.toContain("`librarian`");
  expect(routes.implement).not.toContain("`worker-deep`");
  expect(routes.plan).toContain("`planner`");
});
