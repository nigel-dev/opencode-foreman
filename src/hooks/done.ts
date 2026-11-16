import type { DoneGateConfig } from "../lib/config.js";
import { probability, type Answers, type Decider, type Question } from "../lib/jev.js";
import type { CheckResult } from "../lib/checks.js";
import type { ActivePlan } from "../lib/plans.js";
import { BoundedMap, head, lastTurn, tail, type SessionFacts, type SessionReader } from "../lib/sessions.js";

export const QUESTIONS = {
  work: {
    type: "noul",
    instructions: "Does the request ask the assistant to change code, files, configuration, or systems?",
    criteria: {
      true: "It asks for something to be built, fixed, edited, installed, or otherwise changed",
      false: "It only asks a question, asks for an explanation, a review, a diagnosis, or an opinion",
    },
  },
  blocked: {
    type: "noul",
    instructions:
      "Is the final message handing control back to the user: asking them a question, requesting a decision or approval, listing choices or next steps that are theirs to take, or reporting a blocker only they can resolve?",
  },
  unfinished: {
    type: "noul",
    instructions:
      "Does the final message say that the assistant itself still has requested work to do and could carry on with it now, without anything from the user?",
    criteria: {
      true: "It stopped partway: it names steps of the request it has not done yet and intends to do",
      false:
        "The requested work is finished, or everything left is a decision, approval, or action for the user, or an optional follow-up the request did not ask for",
    },
  },
  claimsDone: {
    type: "noul",
    instructions: "Does the final message say that the requested work is complete?",
  },
  verified: {
    type: "noul",
    instructions:
      "Does the final message report that tests, a build, a type check, a linter, or another validation command was run and passed?",
  },
  waived: {
    type: "noul",
    instructions: "Does the final message explain that no test, build, or other check applies to this work or could be run?",
  },
} as const satisfies Record<string, Question>;

export type Verdict =
  | { readonly action: "none"; readonly reason: string }
  | {
      readonly action: "continue";
      readonly reason: "unfinished" | "unverified" | "checks-failed" | "plan-open";
      readonly text: string;
      /** The failed check command, when a check failed. */
      readonly detail?: string;
    };

const CONTINUE_UNFINISHED =
  "Your last message says work remains. Continue until the request is complete. If you are blocked on something only the user can resolve, say so plainly and stop.";
const CONTINUE_UNVERIFIED =
  "You reported the work as complete without saying it was checked. Run the applicable tests, build, type check, or lint now and report the result. If no check applies, say why.";

function checksFailedText(result: CheckResult): string | undefined {
  const { failure } = result;
  if (!failure) return undefined;
  const status = failure.status === "timeout" ? "timed out" : failure.status === "error" ? "could not be started" : `exited with code ${failure.status}`;
  return [
    `The project's check \`${failure.command}\` ${status} after your last change. Fix what your change broke, then run it again.`,
    "If the failure was already there before you started, say so plainly and stop.",
    "",
    "<output>",
    failure.output || "(no output)",
    "</output>",
  ].join("\n");
}

function planOpenText(plan: ActivePlan): string {
  return `The active plan at \`${plan.path}\` still has ${plan.progress.open} open task${plan.progress.open === 1 ? "" : "s"}. Continue with the next one, and tick each task in the plan file once it is done and verified. If you are blocked on something only the user can resolve, say so plainly and stop.`;
}

/**
 * `claimed` marks a "none" verdict where the assistant says requested work is complete, which is the
 * point at which evidence (project checks, plan progress) is worth gathering.
 */
export function judge(answers: Answers, threshold: number): Verdict & { readonly claimed?: boolean } {
  const read = (name: keyof typeof QUESTIONS) => probability(answers, name);
  const work = read("work");
  const blocked = read("blocked");
  const unfinished = read("unfinished");
  const claimsDone = read("claimsDone");
  const verified = read("verified");
  const waived = read("waived");
  if (
    work === undefined ||
    blocked === undefined ||
    unfinished === undefined ||
    claimsDone === undefined ||
    verified === undefined ||
    waived === undefined
  ) {
    return { action: "none", reason: "incomplete answers" };
  }
  if (work < threshold) return { action: "none", reason: "no change requested" };
  if (blocked >= threshold) return { action: "none", reason: "waiting on the user" };
  if (unfinished >= threshold) return { action: "continue", reason: "unfinished", text: CONTINUE_UNFINISHED };
  if (claimsDone >= threshold && verified < threshold && waived < threshold) {
    return { action: "continue", reason: "unverified", text: CONTINUE_UNVERIFIED, claimed: true };
  }
  return { action: "none", reason: "done", claimed: claimsDone >= threshold };
}

export interface DoneGateDeps {
  readonly config: DoneGateConfig;
  readonly decider: Decider;
  readonly sessions: Pick<SessionReader, "context">;
  readonly lookup: (sessionID: string) => Promise<SessionFacts>;
  readonly nudge: (sessionID: string, text: string) => Promise<void>;
  /** Runs the configured project checks in a directory. Absent when none are configured. */
  readonly runChecks?: ((directory: string) => Promise<CheckResult>) | undefined;
  readonly activePlan?: ((sessionID: string) => Promise<ActivePlan | undefined>) | undefined;
  readonly clearPlan?: ((sessionID: string) => Promise<unknown>) | undefined;
}

export interface IdleEvent {
  readonly sessionID: string;
  readonly background: ReadonlyArray<{ readonly sessionID: string }>;
}

export function createDoneGate(deps: DoneGateDeps): (event: IdleEvent) => Promise<Verdict> {
  const nudges = new BoundedMap<string, { userID: string; count: number }>();

  return async (event) => {
    const { sessionID } = event;
    // The session is woken again when its own background work finishes, so judge it then.
    if (event.background.some((job) => job.sessionID === sessionID)) return { action: "none", reason: "background work running" };
    const facts = await deps.lookup(sessionID);
    if (facts.kind !== "root") return { action: "none", reason: "not a root session" };

    const turn = lastTurn(await deps.sessions.context({ sessionID }));
    if (!turn) return { action: "none", reason: "no completed turn" };
    if (turn.failed) return { action: "none", reason: "turn failed" };

    const previous = nudges.get(sessionID);
    const count = previous?.userID === turn.userID ? previous.count : 0;
    if (count >= deps.config.maxContinuations) return { action: "none", reason: "continuation limit reached" };

    const answers = await deps.decider.ask(
      { request: head(turn.request, 4_000), final_message: tail(turn.reply, 8_000) },
      QUESTIONS,
    );
    if (!answers) return { action: "none", reason: "no decision" };

    const send = async (verdict: Verdict): Promise<Verdict> => {
      if (verdict.action === "continue") {
        nudges.set(sessionID, { userID: turn.userID, count: count + 1 });
        await deps.nudge(sessionID, verdict.text);
      }
      return verdict;
    };

    const { claimed, ...verdict } = judge(answers, deps.config.threshold);
    if (verdict.action === "continue" && verdict.reason === "unfinished") return send(verdict);
    if (verdict.action === "none" && verdict.reason !== "done") return verdict;

    // The assistant says it is finished. From here, evidence outranks its wording.
    const checked = claimed === true && deps.runChecks !== undefined && facts.directory !== undefined;
    if (checked) {
      const result = await deps.runChecks!(facts.directory!);
      const text = checksFailedText(result);
      if (text) return send({ action: "continue", reason: "checks-failed", text, detail: result.failure?.command ?? "" });
    } else if (verdict.action === "continue") {
      return send(verdict);
    }

    const plan = await deps.activePlan?.(sessionID);
    if (plan) {
      if (plan.progress.open > 0) return send({ action: "continue", reason: "plan-open", text: planOpenText(plan) });
      if (plan.progress.done > 0) await deps.clearPlan?.(sessionID);
    }
    return { action: "none", reason: checked ? "checks passed" : "done" };
  };
}
