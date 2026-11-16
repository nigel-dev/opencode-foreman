export const TIERS = ["lead", "reasoning", "consult", "deep", "standard", "fast"] as const;
export type Tier = (typeof TIERS)[number];

export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  /** Shown to the model that chooses which subagent to launch, so it says when to use the agent. */
  readonly description: string;
  readonly mode: "primary" | "subagent" | "all";
  /** Selects the agent's model from the `models` section of the Foreman config. */
  readonly tier: Tier;
  /** Appended after OpenCode's defaults; the last matching rule wins. */
  readonly permissions: readonly PermissionRule[];
  readonly system: string;
}

export const READ_ONLY: readonly PermissionRule[] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
];

export const NO_DELEGATION: readonly PermissionRule[] = [{ action: "subagent", resource: "*", effect: "deny" }];

export const PLAN_DIRECTORY = ".foreman/plans";
