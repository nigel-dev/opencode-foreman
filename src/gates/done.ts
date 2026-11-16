import type { DoneGateConfig } from "../config.js";
import { probability, type Answers, type Decider, type Question } from "../jev.js";
import { BoundedMap, head, lastTurn, tail, type SessionReader } from "../sessions.js";

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
      "Is the final message waiting on the user: asking them a question, requesting a decision or approval, or reporting a blocker only they can resolve?",
  },
  unfinished: {
    type: "noul",
    instructions:
      "Does the final message say that part of the requested work is still not done, or that the assistant will continue with further steps?",
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
  | { readonly action: "continue"; readonly reason: "unfinished" | "unverified"; readonly text: string };

const CONTINUE_UNFINISHED =
  "Your last message says work remains. Continue until the request is complete. If you are blocked on something only the user can resolve, say so plainly and stop.";
const CONTINUE_UNVERIFIED =
  "You reported the work as complete without saying it was checked. Run the applicable tests, build, type check, or lint now and report the result. If no check applies, say why.";

export function judge(answers: Answers, threshold: number): Verdict {
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
    return { action: "continue", reason: "unverified", text: CONTINUE_UNVERIFIED };
  }
  return { action: "none", reason: "done" };
}

export interface DoneGateDeps {
  readonly config: DoneGateConfig;
  readonly decider: Decider;
  readonly sessions: Pick<SessionReader, "context">;
  readonly isRoot: (sessionID: string) => Promise<boolean>;
  readonly nudge: (sessionID: string, text: string) => Promise<void>;
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
    if (!(await deps.isRoot(sessionID))) return { action: "none", reason: "not a root session" };

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

    const verdict = judge(answers, deps.config.threshold);
    if (verdict.action === "continue") {
      nudges.set(sessionID, { userID: turn.userID, count: count + 1 });
      await deps.nudge(sessionID, verdict.text);
    }
    return verdict;
  };
}
