import type { AgentsConfig } from "../lib/config.js";
import type { ModelRef } from "../lib/models.js";
import { BUILTIN_TIERS, ROSTER } from "./index.js";
import type { PermissionRule, Tier } from "./types.js";

export interface AgentDraft {
  name: string;
  description?: string | undefined;
  mode: "primary" | "subagent" | "all";
  hidden: boolean;
  system?: string | undefined;
  model?: ModelRef | undefined;
  permissions: PermissionRule[];
}

export interface AgentEditor {
  get(id: string): unknown;
  update(id: string, update: (agent: AgentDraft) => void): void;
  remove(id: string): void;
  default(id: string | undefined): void;
}

function modelFor(id: string, tier: Tier | undefined, config: AgentsConfig): ModelRef | undefined {
  return config.overrides[id]?.model ?? (tier ? config.tiers[tier] : undefined);
}

/** Every agent that will be given an explicit model, for reporting and availability checks. */
export function assignedModels(config: AgentsConfig): ReadonlyMap<string, ModelRef> {
  const assigned = new Map<string, ModelRef>();
  const consider = (id: string, tier: Tier | undefined) => {
    if (config.overrides[id]?.disabled) return;
    const model = modelFor(id, tier, config);
    if (model) assigned.set(id, model);
  };
  if (config.bundled) for (const agent of ROSTER) consider(agent.id, agent.tier);
  for (const [id, tier] of Object.entries(BUILTIN_TIERS)) consider(id, tier);
  for (const id of Object.keys(config.overrides)) if (!assigned.has(id)) consider(id, undefined);
  return assigned;
}

/**
 * Runs inside an agent transform, which OpenCode replays from a fresh registry, so it must stay
 * synchronous and free of side effects.
 */
export function applyAgents(editor: AgentEditor, config: AgentsConfig): void {
  const bundled = new Set<string>();

  if (config.bundled) {
    for (const definition of ROSTER) {
      bundled.add(definition.id);
      // Disabling a bundled agent only withholds ours; an agent the user defined under the same ID is left alone.
      if (config.overrides[definition.id]?.disabled) continue;
      const model = modelFor(definition.id, definition.tier, config);
      editor.update(definition.id, (agent) => {
        agent.name = definition.name;
        agent.description = definition.description;
        agent.mode = definition.mode;
        agent.hidden = false;
        agent.system = definition.system;
        agent.permissions.push(...definition.permissions);
        if (model) agent.model = model;
      });
    }
  }

  const others = new Set([...Object.keys(BUILTIN_TIERS), ...Object.keys(config.overrides)]);
  for (const id of others) {
    if (bundled.has(id) || editor.get(id) === undefined) continue;
    if (config.overrides[id]?.disabled) {
      editor.remove(id);
      continue;
    }
    const model = modelFor(id, BUILTIN_TIERS[id], config);
    if (model) {
      editor.update(id, (agent) => {
        agent.model = model;
      });
    }
  }

  if (config.defaultAgent && editor.get(config.defaultAgent) !== undefined) editor.default(config.defaultAgent);
}
