import { desiredVariant, type AgentModel } from "./format.js";

interface ModelSelection {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string | undefined;
}

/** Tracks one model selection, leaving an ambiguous agent choice pending until it can be decided. */
export function createVariantSync() {
  let state: { model: string; variant: string | undefined; settled: boolean } | undefined;
  return (enabled: boolean, current: ModelSelection | undefined, agents: readonly AgentModel[] | undefined, sessionAgent?: string): string | undefined => {
    if (!enabled || !current || !agents || agents.length === 0) return;
    const model = `${current.providerID}/${current.modelID}`;
    if (state?.model !== model) state = { model, variant: current.variant, settled: false };
    if (state.settled) return;
    // A variant change while waiting is a user choice, not a reason to retry the configured default.
    if (current.variant !== state.variant) {
      state.settled = true;
      return;
    }
    const wanted = desiredVariant(agents, current, sessionAgent);
    if (
      wanted === undefined &&
      !sessionAgent &&
      agents.some((agent) => agent.model?.variant !== undefined && agent.model.providerID === current.providerID && agent.model.id === current.modelID)
    ) return;
    state.settled = true;
    return wanted && wanted !== current.variant ? wanted : undefined;
  };
}
