import type { AgentsConfig } from "../lib/config.js";
import type { ModelRef } from "../lib/models.js";
import { BUILTIN_TIERS, ROSTER } from "./index.js";
import type { AgentDefinition, PermissionRule, Tier } from "./types.js";

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

/**
 * OpenCode's stock default agent is "build". The foreman replaces it with its own roster, but
 * commands and configs written for vanilla OpenCode still reference the ID. These aliases map
 * retired stock IDs to the foreman agent that fills the same role, registered as hidden so they
 * resolve without cluttering the agent picker.
 *
 * An alias is registered only when bundled agents are on and its target is a bundled agent that
 * is not disabled. A registered alias mirrors its target exactly, including the target's effective
 * model (so `agents.<target>.model` is honoured). Any `agents.<alias>` override (`model` or
 * `disabled`) is ignored while the alias is registered, because that entry was aimed at the stock
 * agent the alias replaces. When the alias is not registered, the ID is handled like any other
 * non-bundled agent, so its overrides apply to the stock agent.
 */
const ALIASES: Readonly<Record<string, string>> = { build: "orchestrator" };

interface ResolvedAlias {
  id: string;
  target: AgentDefinition;
  model: ModelRef | undefined;
}

/** The aliases that will be registered for this config. Shared by registration and reporting so they cannot drift. */
function resolveAliases(config: AgentsConfig): ResolvedAlias[] {
  if (!config.bundled) return [];
  const resolved: ResolvedAlias[] = [];
  for (const [id, targetId] of Object.entries(ALIASES)) {
    if (ROSTER.some((definition) => definition.id === id)) continue;
    const target = ROSTER.find((definition) => definition.id === targetId);
    if (!target || config.overrides[target.id]?.disabled) continue;
    resolved.push({ id, target, model: modelFor(target.id, target.tier, config) });
  }
  return resolved;
}

/** Every agent that will be given an explicit model, for reporting and availability checks. */
export function assignedModels(config: AgentsConfig): ReadonlyMap<string, ModelRef> {
  const assigned = new Map<string, ModelRef>();
  const aliases = resolveAliases(config);
  const aliasIds = new Set(aliases.map((alias) => alias.id));
  const consider = (id: string, tier: Tier | undefined) => {
    if (aliasIds.has(id) || config.overrides[id]?.disabled) return;
    const model = modelFor(id, tier, config);
    if (model) assigned.set(id, model);
  };
  if (config.bundled) for (const agent of ROSTER) consider(agent.id, agent.tier);
  for (const alias of aliases) if (alias.model) assigned.set(alias.id, alias.model);
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

  // Register hidden aliases so stock OpenCode agent IDs resolve to their foreman equivalents.
  const aliasIds = new Set<string>();
  for (const { id, target, model } of resolveAliases(config)) {
    aliasIds.add(id);
    editor.update(id, (agent) => {
      agent.name = target.name;
      agent.description = target.description;
      agent.mode = target.mode;
      agent.hidden = true;
      agent.system = target.system;
      agent.permissions.push(...target.permissions);
      // Replaced even when undefined, so a model left on the stock agent cannot outlive the alias.
      agent.model = model;
    });
  }

  const others = new Set([...Object.keys(BUILTIN_TIERS), ...Object.keys(config.overrides)]);
  for (const id of others) {
    if (bundled.has(id) || aliasIds.has(id) || editor.get(id) === undefined) continue;
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
