import { expect, test } from "bun:test";
import { BUILTIN_TIERS, ROSTER, TIERS } from "../../src/agents/index.js";
import { applyAgents, assignedModels, type AgentDraft, type AgentEditor } from "../../src/agents/register.js";
import { resolveConfig } from "../../src/lib/config.js";

function fakeEditor(existing: Record<string, Partial<AgentDraft>> = {}) {
  const agents = new Map<string, AgentDraft>();
  const blank = (id: string): AgentDraft => ({ name: id, mode: "primary", hidden: false, permissions: [] });
  for (const [id, agent] of Object.entries(existing)) agents.set(id, { ...blank(id), ...agent });
  const state: { defaultAgent?: string | undefined } = {};
  const editor: AgentEditor = {
    get: (id) => agents.get(id),
    update: (id, update) => {
      const agent = agents.get(id) ?? blank(id);
      update(agent);
      agents.set(id, agent);
    },
    remove: (id) => void agents.delete(id),
    default: (id) => {
      state.defaultAgent = id;
    },
  };
  return { editor, agents, state };
}

function agentsConfig(options: Record<string, unknown>) {
  const warnings: string[] = [];
  return { config: resolveConfig(options, {}, warnings).agents, warnings };
}

test("the roster is well formed", () => {
  const ids = ROSTER.map((agent) => agent.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const agent of ROSTER) {
    expect(agent.id).toMatch(/^[a-z][a-z-]*$/);
    expect(TIERS).toContain(agent.tier);
    expect(agent.description.length).toBeGreaterThan(20);
    expect(agent.system.length).toBeGreaterThan(200);
  }
  expect(ROSTER.filter((agent) => agent.mode !== "subagent").map((agent) => agent.id)).toEqual(["orchestrator", "planner", "deep"]);
});

test("every subagent the prompts and permissions name exists", () => {
  const known = new Set([...ROSTER.map((agent) => agent.id), ...Object.keys(BUILTIN_TIERS)]);
  for (const agent of ROSTER) {
    for (const rule of agent.permissions) {
      if (rule.action === "subagent" && rule.resource !== "*") expect(known).toContain(rule.resource);
    }
  }
  const orchestrator = ROSTER.find((agent) => agent.id === "orchestrator");
  const mentioned = [...(orchestrator?.system.matchAll(/^- `([a-z-]+)`:/gm) ?? [])].flatMap((match) => (match[1] ? [match[1]] : []));
  expect(mentioned.length).toBeGreaterThan(5);
  for (const id of mentioned) expect(known).toContain(id);
});

test("with no models configured, bundled agents are registered without a model", () => {
  const { editor, agents, state } = fakeEditor({ explore: { mode: "subagent" } });
  applyAgents(editor, agentsConfig({}).config);
  expect(agents.size).toBe(ROSTER.length + 1);
  expect(agents.get("orchestrator")).toMatchObject({ name: "Orchestrator", mode: "primary", hidden: false });
  expect(agents.get("orchestrator")?.model).toBeUndefined();
  expect(agents.get("explore")?.model).toBeUndefined();
  const oracle = agents.get("oracle")?.permissions ?? [];
  expect(oracle.slice(0, 2)).toEqual([
    { action: "edit", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ]);
  expect(oracle).toContainEqual({ action: "shell", resource: "git push *", effect: "deny" });
  // Agents that run a command from a planner or deep session can reach the reviewer for /review-work.
  for (const id of ["planner", "deep"]) {
    expect(agents.get(id)?.permissions.at(-1 - (id === "planner" ? 14 : 0))).toEqual({ action: "subagent", resource: "reviewer", effect: "allow" });
  }
  expect(state.defaultAgent).toBeUndefined();
});

test("tier models apply to every agent in the tier and per-agent models override them", () => {
  const { config } = agentsConfig({
    models: { fast: "anthropic/claude-haiku-5-5#low", consult: "openai/gpt-6-astra#high" },
    agents: { "plan-reviewer": { model: "openai/gpt-6-astra#xhigh" }, build: { model: "anthropic/claude-sonnet-5-5" } },
  });
  const { editor, agents } = fakeEditor({ explore: { mode: "subagent" }, build: {} });
  applyAgents(editor, config);
  const haiku = { providerID: "anthropic", id: "claude-haiku-5-5", variant: "low" };
  expect(agents.get("librarian")?.model).toEqual(haiku);
  expect(agents.get("worker-quick")?.model).toEqual(haiku);
  expect(agents.get("explore")?.model).toEqual(haiku);
  expect(agents.get("oracle")?.model).toEqual({ providerID: "openai", id: "gpt-6-astra", variant: "high" });
  expect(agents.get("plan-reviewer")?.model).toEqual({ providerID: "openai", id: "gpt-6-astra", variant: "xhigh" });
  expect(agents.get("build")?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" });
  expect(agents.get("worker")?.model).toBeUndefined();
  expect(Object.fromEntries(assignedModels(config))).toMatchObject({ explore: haiku, build: { id: "claude-sonnet-5-5" } });
  expect(assignedModels(config).has("worker")).toBe(false);
});

test("disabling a bundled agent withholds ours, and disabling any other agent removes it", () => {
  const { config } = agentsConfig({ agents: { writer: { disabled: true }, legacy: { disabled: true }, ghost: { disabled: true } } });
  const { editor, agents } = fakeEditor({ writer: { system: "mine" }, legacy: {} });
  applyAgents(editor, config);
  expect(agents.get("writer")?.system).toBe("mine");
  expect(agents.has("legacy")).toBe(false);
  expect(agents.has("ghost")).toBe(false);
});

test("bundledAgents false registers nothing but still applies models to existing agents", () => {
  const { config } = agentsConfig({ bundledAgents: false, models: { fast: "a/b" }, agents: { worker: { model: "c/d" } } });
  const { editor, agents } = fakeEditor({ explore: {}, worker: { system: "user worker" } });
  applyAgents(editor, config);
  expect([...agents.keys()].sort()).toEqual(["explore", "worker"]);
  expect(agents.get("explore")?.model).toEqual({ providerID: "a", id: "b" });
  expect(agents.get("worker")).toMatchObject({ system: "user worker", model: { providerID: "c", id: "d" } });
});

test("defaultAgent is set only when that agent exists", () => {
  const present = fakeEditor();
  applyAgents(present.editor, agentsConfig({ defaultAgent: "orchestrator" }).config);
  expect(present.state.defaultAgent).toBe("orchestrator");

  const missing = fakeEditor();
  applyAgents(missing.editor, agentsConfig({ defaultAgent: "nobody" }).config);
  expect(missing.state.defaultAgent).toBeUndefined();
});

test("malformed models and unknown tiers are reported and ignored", () => {
  const { config, warnings } = agentsConfig({ models: { fast: "nonsense", turbo: "a/b" }, agents: { worker: { model: 5 } } });
  expect(config.tiers).toEqual({});
  expect(config.overrides.worker).toEqual({});
  expect(warnings).toHaveLength(3);
});

test("routing hints name bundled agents only when they are registered", () => {
  expect(resolveConfig({}, {}).intentGate.routes.research).toContain("`librarian`");
  expect(resolveConfig({ bundledAgents: false }, {}).intentGate.routes.research).not.toContain("`librarian`");
});
