import type { ReportGateConfig } from "../lib/config.js";
import { probability, type Answers, type Decider, type Question } from "../lib/jev.js";
import type { Operation } from "../lib/operations.js";
import { head, lastTurn, tail, type SessionFacts, type SessionReader } from "../lib/sessions.js";
import { identifyTurn, type SessionState } from "../lib/state.js";
import type { IdleEvent } from "./done.js";

export const QUESTIONS = {
  outcome: {
    type: "noul",
    instructions: "Does the report state a concrete result: what was found, changed, or concluded?",
    criteria: {
      true: "It gives findings, a conclusion, a list of changes, or a clear statement that the task could not be done and why",
      false: "It is empty, only describes the process, only restates the task, or only says that work was done without saying what",
    },
  },
  unfinished: {
    type: "noul",
    instructions: "Does the report say the agent stopped partway and still intends to do more of the task it was given?",
    criteria: {
      true: "It names parts of the task it has not done yet and plans to do",
      false: "The task is finished, or it explains what blocked it and hands back to the caller",
    },
  },
} as const satisfies Record<string, Question>;

export type ReportVerdict =
  | { readonly action: "none"; readonly reason: string }
  | { readonly action: "revise"; readonly reason: "unfinished" | "no-outcome"; readonly text: string };

const REVISE_UNFINISHED =
  "Your report says part of the task is still to do. Finish it now, then report. If something blocks you, say exactly what and stop.";
const REVISE_NO_OUTCOME =
  "Your final message is the only thing the caller receives, and it does not say what the outcome was. Rewrite it: lead with what you found, changed, or concluded; say what you verified and what you did not; give file paths for anything the caller needs to open.";

export function judgeReport(answers: Answers, threshold: number): ReportVerdict {
  const outcome = probability(answers, "outcome");
  const unfinished = probability(answers, "unfinished");
  if (outcome === undefined || unfinished === undefined) return { action: "none", reason: "incomplete answers" };
  if (unfinished >= threshold) return { action: "revise", reason: "unfinished", text: REVISE_UNFINISHED };
  if (outcome < threshold) return { action: "revise", reason: "no-outcome", text: REVISE_NO_OUTCOME };
  return { action: "none", reason: "usable report" };
}

export interface ReportGateDeps {
  readonly config: ReportGateConfig;
  readonly decider: Decider;
  readonly sessions: Pick<SessionReader, "context">;
  readonly lookup: (sessionID: string) => Promise<SessionFacts>;
  readonly state: SessionState;
  readonly nudge: (sessionID: string, text: string) => Promise<void>;
}

const CANCELLED: ReportVerdict = { action: "none", reason: "cancelled" };

/** Checks a subagent's report just before its session goes idle, which is when the parent would receive it. */
export function createReportGate(deps: ReportGateDeps): (event: IdleEvent, operation: Operation) => Promise<ReportVerdict> {
  return async (event, operation) => {
    const { sessionID } = event;
    if (event.background.some((job) => job.sessionID === sessionID)) return { action: "none", reason: "background work running" };
    const facts = await deps.lookup(sessionID);
    if (facts.kind !== "child") return { action: "none", reason: "not a subagent session" };
    // Pausing a session pauses the subagents it launched; a subagent session can also be paused itself.
    const paused = async () => (await deps.state.read(sessionID)).paused === true || (facts.parentID !== undefined && (await deps.state.read(facts.parentID)).paused === true);
    if (await paused()) return { action: "none", reason: "paused" };

    const record = await deps.state.read(sessionID);
    const turn = lastTurn(await deps.sessions.context({ sessionID }));
    const identity = turn && identifyTurn(turn, record);
    if (!turn || !identity) return { action: "none", reason: "no completed turn" };
    if (turn.failed) return { action: "none", reason: "turn failed" };
    // One revision per brief: a second weak report goes to the parent, which can decide what to do with it.
    if (record.revised === identity.requestID) return { action: "none", reason: "already revised" };

    // An empty report is asked about like any other (the `outcome` criteria name it as "false"), so an
    // unavailable decision model leaves it alone instead of revising without a decision.
    const answers = await deps.decider.ask({ task: head(identity.request, 4_000), report: tail(turn.reply, 8_000) }, QUESTIONS);
    if (!answers) return { action: "none", reason: "no decision" };
    const verdict = judgeReport(answers, deps.config.threshold);

    if (verdict.action === "revise") {
      // The parent may have been paused while the model was deciding.
      if (await paused()) return { action: "none", reason: "paused" };
      // Checked immediately before sending, with nothing awaited in between.
      if (!operation.live()) return CANCELLED;
      await deps.nudge(sessionID, verdict.text);
      await deps.state.update(sessionID, { revised: identity.requestID });
    }
    return verdict;
  };
}
