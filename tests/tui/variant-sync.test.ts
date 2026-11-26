import { expect, test } from "bun:test";
import type { AgentModel } from "../../src/tui/format.js";
import { createVariantSync } from "../../src/tui/variant-sync.js";

const model = { providerID: "provider", modelID: "shared" };
const agents: readonly AgentModel[] = [
  { id: "orchestrator", mode: "primary", model: { providerID: "provider", id: "shared", variant: "high" } },
  { id: "deep", mode: "primary", model: { providerID: "provider", id: "shared", variant: "low" } },
  { id: "planner", mode: "primary", model: { providerID: "provider", id: "other", variant: "max" } },
];

test("an ambiguous model waits for the first session's agent before applying its variant", () => {
  const sync = createVariantSync();
  expect(sync(true, { ...model, variant: "low" }, agents)).toBeUndefined();
  expect(sync(true, { ...model, variant: "low" }, agents)).toBeUndefined();
  expect(sync(true, { ...model, variant: "low" }, agents, "orchestrator")).toBe("high");
  expect(sync(true, { ...model, variant: "high" }, agents, "orchestrator")).toBeUndefined();
});

test("a user pick after applying a configured variant survives the first session's agent resolving", () => {
  const sync = createVariantSync();
  const agreed = agents.filter((agent) => agent.id !== "deep");
  expect(sync(true, { ...model, variant: "low" }, agreed)).toBe("high");
  expect(sync(true, { ...model, variant: "high" }, agreed)).toBeUndefined();
  expect(sync(true, { ...model, variant: "max" }, agreed)).toBeUndefined();
  expect(sync(true, { ...model, variant: "max" }, agreed, "orchestrator")).toBeUndefined();
});

test("a configured variant already selected still settles before a user picks another variant", () => {
  const sync = createVariantSync();
  const agreed = agents.filter((agent) => agent.id !== "deep");
  expect(sync(true, { ...model, variant: "high" }, agreed)).toBeUndefined();
  expect(sync(true, { ...model, variant: "low" }, agreed)).toBeUndefined();
  expect(sync(true, { ...model, variant: "low" }, agreed, "orchestrator")).toBeUndefined();
});

test("a user pick while the agent choice is pending survives the agent resolving", () => {
  const sync = createVariantSync();
  expect(sync(true, { ...model, variant: "low" }, agents)).toBeUndefined();
  expect(sync(true, { ...model, variant: "max" }, agents)).toBeUndefined();
  expect(sync(true, { ...model, variant: "max" }, agents, "orchestrator")).toBeUndefined();
});

test("a user pick batched with the agent resolving is kept", () => {
  const sync = createVariantSync();
  expect(sync(true, { ...model, variant: "low" }, agents)).toBeUndefined();
  expect(sync(true, { ...model, variant: "max" }, agents, "orchestrator")).toBeUndefined();
});

test("a model change reapplies configured variants, including on returning to the previous model", () => {
  const sync = createVariantSync();
  expect(sync(true, { ...model, variant: "low" }, agents, "orchestrator")).toBe("high");
  expect(sync(true, { ...model, variant: "max" }, agents, "orchestrator")).toBeUndefined();
  expect(sync(true, { ...model, modelID: "other", variant: "low" }, agents, "orchestrator")).toBe("max");
  expect(sync(true, { ...model, variant: "low" }, agents, "orchestrator")).toBe("high");
});

test("a provider change also counts as a model change", () => {
  const sync = createVariantSync();
  const providers = [...agents, { id: "custom", mode: "primary", model: { providerID: "other", id: "shared", variant: "max" } }];
  expect(sync(true, { ...model, variant: "low" }, providers, "orchestrator")).toBe("high");
  expect(sync(true, { ...model, providerID: "other", variant: "low" }, providers, "orchestrator")).toBe("max");
});

test("syncVariants off makes no decisions or writes, including when the agent resolves", () => {
  const sync = createVariantSync();
  expect(sync(false, { ...model, variant: "low" }, agents)).toBeUndefined();
  expect(sync(false, { ...model, variant: "max" }, agents, "orchestrator")).toBeUndefined();
  expect(sync(false, { ...model, modelID: "other", variant: "low" }, agents, "planner")).toBeUndefined();
  expect(sync(true, { ...model, variant: "low" }, agents, "orchestrator")).toBe("high");
});

test("missing model or agent data does not settle the choice before the data loads", () => {
  const sync = createVariantSync();
  expect(sync(true, undefined, agents)).toBeUndefined();
  expect(sync(true, { ...model, variant: "low" }, undefined)).toBeUndefined();
  expect(sync(true, { ...model, variant: "low" }, [])).toBeUndefined();
  expect(sync(true, { ...model, variant: "low" }, agents, "orchestrator")).toBe("high");
});

test("a hidden or subagent variant stays pending because the session's own agent may select it", () => {
  for (const fields of [{ mode: "primary", hidden: true }, { mode: "subagent" }]) {
    const sync = createVariantSync();
    const own = [{ id: "custom", ...fields, model: { providerID: "provider", id: "shared", variant: "high" } }];
    expect(sync(true, { ...model, variant: "low" }, own)).toBeUndefined();
    expect(sync(true, { ...model, variant: "low" }, own, "custom")).toBe("high");
  }
});

test("a model with no configured variant is settled without changing the selection", () => {
  const sync = createVariantSync();
  const unconfigured = { ...model, modelID: "unconfigured", variant: "low" };
  expect(sync(true, unconfigured, agents)).toBeUndefined();
  const updated = [...agents, { id: "custom", mode: "primary", model: { providerID: "provider", id: "unconfigured", variant: "high" } }];
  expect(sync(true, unconfigured, updated, "custom")).toBeUndefined();
});
