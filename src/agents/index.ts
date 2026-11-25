import { deep } from "./deep.js";
import { orchestrator } from "./orchestrator.js";
import { planner } from "./planner.js";
import { securityResearcher } from "./security.js";
import { librarian, oracle, planConsultant, planReviewer, reviewer, tester, writer } from "./specialists.js";
import type { AgentDefinition, Tier } from "./types.js";
import { worker, workerDeep, workerQuick, workerVisual } from "./workers.js";

export const ROSTER: readonly AgentDefinition[] = [
  orchestrator,
  planner,
  deep,
  securityResearcher,
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

/** Agents that do their own work; a routing hint for them leaves out the delegation advice. */
export const SOLO_AGENTS: readonly string[] = ["deep", "planner", "security-researcher"];

/**
 * Routing-hint text that names the bundled agents. An intent whose agents are not all available falls
 * back to `generic`, so a hint never points at an agent that does not exist.
 */
export function rosterRoutes<Key extends string>(available: (agent: string) => boolean, generic: Readonly<Record<Key, string>>): Record<Key, string> {
  const routes: Record<string, { needs: readonly string[]; text: string }> = {
    trivial: { needs: ["worker-quick"], text: "Handle it yourself, or hand a purely mechanical edit to `worker-quick`." },
    explore: { needs: ["explore"], text: "Send `explore` to find the answer in the codebase, then report. Do not edit files." },
    implement: {
      needs: ["worker", "worker-deep", "worker-visual"],
      text: "Delegate to a worker sized to the task (`worker`, `worker-deep` for hard or cross-cutting work, `worker-visual` for UI), then verify the result yourself.",
    },
    plan: { needs: ["planner"], text: "Suggest the `planner` agent for a written plan before any edits." },
    research: { needs: ["librarian"], text: "Send `librarian` to check external sources, then summarise with citations. Do not edit files." },
  };
  return Object.fromEntries(
    (Object.keys(generic) as Key[]).map((intent) => {
      const route = routes[intent];
      return [intent, route && route.needs.every(available) ? route.text : generic[intent]];
    }),
  ) as Record<Key, string>;
}

export type { AgentDefinition, Tier } from "./types.js";
export { TIERS } from "./types.js";
