import { createCommands, type CommandDefinition, type CommandDeps } from "./commands.js";
import { createApprovalGate, type ApprovalRecord, type EvaluateEvent, type Outcome } from "./hooks/approval.js";
import { createDoneGate, type IdleEvent, type Verdict } from "./hooks/done.js";
import { createIntentGate, type IntentGate } from "./hooks/intent.js";
import { createLoopGuard, type LoopGuard, type LoopHistories } from "./hooks/loop.js";
import { createReportGate, type ReportVerdict } from "./hooks/report.js";
import { runChecks, type CheckProgress } from "./lib/checks.js";
import { bundledAgentAvailable, type ForemanConfig } from "./lib/config.js";
import { createJevDecider, type JevOutcome } from "./lib/jev.js";
import type { Operation } from "./lib/operations.js";
import type { PlanStore } from "./lib/plans.js";
import type { SessionFacts, SessionReader } from "./lib/sessions.js";
import type { SessionState } from "./lib/state.js";
import { traced } from "./lib/trace.js";

/**
 * What outlives a config change: per-session supervision state, loop histories, and the host callbacks.
 * Only the gates built from the config are replaced.
 */
export interface RuntimeDeps extends Omit<CommandDeps, "available" | "plans" | "lookup"> {
  readonly sessions: Pick<SessionReader, "context">;
  readonly lookup: (sessionID: string) => Promise<SessionFacts>;
  readonly plans: PlanStore;
  readonly state: SessionState;
  readonly loopHistories: LoopHistories;
  readonly nudge: (description: string) => (sessionID: string, text: string) => Promise<void>;
  readonly audit: (record: ApprovalRecord) => Promise<void>;
  readonly onDecisionModel: (outcome: JevOutcome) => void;
  /** Told when a check command starts, and with `undefined` when the run ends. */
  readonly onCheck: (sessionID: string, progress: CheckProgress | undefined) => void;
}

/** Everything built from one version of the config. Rebuilt whole when a config file changes. */
export interface Runtime {
  readonly config: ForemanConfig;
  readonly decisionModel: boolean;
  readonly commands: readonly CommandDefinition[];
  readonly loopGuard: LoopGuard | undefined;
  readonly doneGate: ((event: IdleEvent, operation: Operation) => Promise<Verdict>) | undefined;
  readonly reportGate: ((event: IdleEvent, operation: Operation) => Promise<ReportVerdict>) | undefined;
  readonly intentGate: IntentGate | undefined;
  readonly approvalGate: ((event: EvaluateEvent) => Promise<Outcome>) | undefined;
}

export function buildRuntime(config: ForemanConfig, deps: RuntimeDeps): Runtime {
  const { lookup, plans, state } = deps;
  const base = createJevDecider(config.jev, undefined, deps.onDecisionModel);
  const decider = base && traced(base);
  const { checks, checkTimeoutMs } = config.doneGate;

  return {
    config,
    decisionModel: decider !== undefined,
    commands: config.commands ? createCommands({ ...deps, available: (agent) => bundledAgentAvailable(config.agents, agent) }) : [],
    loopGuard: config.loopGuard.enabled ? createLoopGuard(config.loopGuard, deps.loopHistories) : undefined,
    doneGate:
      decider && config.doneGate.enabled
        ? createDoneGate({
            config: config.doneGate,
            decider,
            sessions: deps.sessions,
            lookup,
            state,
            nudge: deps.nudge("Foreman done gate"),
            runChecks:
              checks.length > 0
                ? async (directory, sessionID, signal) => {
                    try {
                      return await runChecks(checks, directory, checkTimeoutMs, { signal, onStart: (progress) => deps.onCheck(sessionID, progress) });
                    } finally {
                      deps.onCheck(sessionID, undefined);
                    }
                  }
                : undefined,
            activePlan: config.plans.enabled ? (sessionID) => plans.active(sessionID) : undefined,
            clearPlan: (sessionID) => plans.clear(sessionID),
          })
        : undefined,
    reportGate:
      decider && config.reportGate.enabled
        ? createReportGate({ config: config.reportGate, decider, sessions: deps.sessions, lookup, state, nudge: deps.nudge("Foreman report gate") })
        : undefined,
    intentGate:
      decider && config.intentGate.enabled
        ? createIntentGate({ config: config.intentGate, decider, isRoot: async (sessionID) => (await lookup(sessionID)).kind === "root" })
        : undefined,
    approvalGate: decider && config.approval.enabled ? createApprovalGate({ config: config.approval, decider, audit: deps.audit }) : undefined,
  };
}
