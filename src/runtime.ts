import { createCommands, type CommandDefinition, type CommandDeps } from "./commands.js";
import { createApprovalGate, type ApprovalRecord, type EvaluateEvent, type Outcome } from "./hooks/approval.js";
import { createDoneGate, type IdleEvent, type Verdict } from "./hooks/done.js";
import { createIntentGate, type IntentGate } from "./hooks/intent.js";
import { createLoopGuard, type ToolCallEvent } from "./hooks/loop.js";
import { createReportGate, type ReportVerdict } from "./hooks/report.js";
import { runChecks } from "./lib/checks.js";
import type { ForemanConfig } from "./lib/config.js";
import { createJevDecider } from "./lib/jev.js";
import type { PlanStore } from "./lib/plans.js";
import type { SessionFacts, SessionReader } from "./lib/sessions.js";
import { traced } from "./lib/trace.js";

export interface RuntimeDeps extends Omit<CommandDeps, "bundledAgents" | "plans" | "lookup"> {
  readonly sessions: Pick<SessionReader, "context">;
  readonly lookup: (sessionID: string) => Promise<SessionFacts>;
  readonly plans: PlanStore;
  readonly nudge: (description: string) => (sessionID: string, text: string) => Promise<void>;
  readonly audit: (record: ApprovalRecord) => Promise<void>;
}

/** Everything built from one version of the config. Rebuilt whole when a config file changes. */
export interface Runtime {
  readonly config: ForemanConfig;
  readonly decisionModel: boolean;
  readonly commands: readonly CommandDefinition[];
  readonly loopGuard: ((event: ToolCallEvent) => void) | undefined;
  readonly doneGate: ((event: IdleEvent) => Promise<Verdict>) | undefined;
  readonly reportGate: ((event: IdleEvent) => Promise<ReportVerdict>) | undefined;
  readonly intentGate: IntentGate | undefined;
  readonly approvalGate: ((event: EvaluateEvent) => Promise<Outcome>) | undefined;
}

export function buildRuntime(config: ForemanConfig, deps: RuntimeDeps): Runtime {
  const { lookup, plans } = deps;
  const base = createJevDecider(config.jev);
  const decider = base && traced(base);
  const { checks, checkTimeoutMs } = config.doneGate;

  return {
    config,
    decisionModel: decider !== undefined,
    commands: config.commands ? createCommands({ ...deps, bundledAgents: config.agents.bundled }) : [],
    loopGuard: config.loopGuard.enabled ? createLoopGuard(config.loopGuard) : undefined,
    doneGate:
      decider && config.doneGate.enabled
        ? createDoneGate({
            config: config.doneGate,
            decider,
            sessions: deps.sessions,
            lookup,
            nudge: deps.nudge("Foreman done gate"),
            runChecks: checks.length > 0 ? (directory) => runChecks(checks, directory, checkTimeoutMs) : undefined,
            activePlan: config.plans.enabled ? (sessionID) => plans.active(sessionID) : undefined,
            clearPlan: (sessionID) => plans.clear(sessionID),
          })
        : undefined,
    reportGate:
      decider && config.reportGate.enabled
        ? createReportGate({ config: config.reportGate, decider, sessions: deps.sessions, lookup, nudge: deps.nudge("Foreman report gate") })
        : undefined,
    intentGate:
      decider && config.intentGate.enabled
        ? createIntentGate({ config: config.intentGate, decider, isRoot: async (sessionID) => (await lookup(sessionID)).kind === "root" })
        : undefined,
    approvalGate: decider && config.approval.enabled ? createApprovalGate({ config: config.approval, decider, audit: deps.audit }) : undefined,
  };
}
