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

/**
 * Shell commands that change the working tree or its history. Denying them keeps a reviewing or planning
 * agent from changing files by accident. It is a short list, not a sandbox: a build or test the agent is
 * allowed to run can still write files.
 */
export const NO_MUTATING_SHELL: readonly PermissionRule[] = [
  "rm *",
  "mv *",
  "git add *",
  "git commit *",
  "git push *",
  "git reset *",
  "git checkout *",
  "git switch *",
  "git restore *",
  "git clean *",
  "git stash *",
  "git merge *",
  "git rebase *",
  "git apply *",
].map((resource) => ({ action: "shell", resource, effect: "deny" as const }));

/** No edit tools and no delegation. The agent can still read, search, and run non-mutating commands. */
export const NO_EDITS: readonly PermissionRule[] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  ...NO_MUTATING_SHELL,
];

export const NO_DELEGATION: readonly PermissionRule[] = [{ action: "subagent", resource: "*", effect: "deny" }];

export const PLAN_DIRECTORY = ".foreman/plans";
