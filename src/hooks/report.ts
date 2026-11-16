import type { ReportGateConfig } from "../lib/config.js";
import { probability, type Answers, type Decider, type Question } from "../lib/jev.js";
import { BoundedMap, head, lastTurn, tail, type SessionFacts, type SessionReader } from "../lib/sessions.js";
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
  readonly nudge: (sessionID: string, text: string) => Promise<void>;
}

/** Checks a subagent's report just before its session goes idle, which is when the parent would receive it. */
export function createReportGate(deps: ReportGateDeps): (event: IdleEvent) => Promise<ReportVerdict> {
  const revised = new BoundedMap<string, string>();

  return async (event) => {
    const { sessionID } = event;
    if (event.background.some((job) => job.sessionID === sessionID)) return { action: "none", reason: "background work running" };
    if ((await deps.lookup(sessionID)).kind !== "child") return { action: "none", reason: "not a subagent session" };

    const turn = lastTurn(await deps.sessions.context({ sessionID }));
    if (!turn) return { action: "none", reason: "no completed turn" };
    if (turn.failed) return { action: "none", reason: "turn failed" };
    // One revision per brief: a second weak report goes to the parent, which can decide what to do with it.
    if (revised.get(sessionID) === turn.userID) return { action: "none", reason: "already revised" };

    const answers = await deps.decider.ask({ task: head(turn.request, 4_000), report: tail(turn.reply, 8_000) }, QUESTIONS);
    if (!answers) return { action: "none", reason: "no decision" };

    const verdict = judgeReport(answers, deps.config.threshold);
    if (verdict.action === "revise") {
      revised.set(sessionID, turn.userID);
      await deps.nudge(sessionID, verdict.text);
    }
    return verdict;
  };
}
