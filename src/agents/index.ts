import { deep } from "./deep.js";
import { orchestrator } from "./orchestrator.js";
import { planner } from "./planner.js";
import { librarian, oracle, planConsultant, planReviewer, reviewer, tester, writer } from "./specialists.js";
import type { AgentDefinition, Tier } from "./types.js";
import { worker, workerDeep, workerQuick, workerVisual } from "./workers.js";

export const ROSTER: readonly AgentDefinition[] = [
  orchestrator,
  planner,
  deep,
  worker,
  workerQuick,
  workerDeep,
  workerVisual,
  tester,
  writer,
  librarian,
  oracle,
  planConsultant,
  planReviewer,
  reviewer,
];

/** OpenCode's own agents that the roster relies on. They keep their prompts and only take a model from their tier. */
export const BUILTIN_TIERS: Readonly<Record<string, Tier>> = {
  explore: "fast",
};

/** Routing-hint text used when the bundled agents are registered, so hints name agents that exist. */
export const ROSTER_ROUTES = {
  trivial: "Handle it yourself, or hand a purely mechanical edit to `worker-quick`.",
  explore: "Send `explore` to find the answer in the codebase, then report. Do not edit files.",
  implement:
    "Delegate to a worker sized to the task (`worker`, `worker-deep` for hard or cross-cutting work, `worker-visual` for UI), then verify the result yourself.",
  plan: "Suggest the `planner` agent for a written plan before any edits.",
  research: "Send `librarian` to check external sources, then summarise with citations. Do not edit files.",
  discuss: "Answer directly. Do not edit files or delegate.",
} as const;

export type { AgentDefinition, Tier } from "./types.js";
export { TIERS } from "./types.js";
