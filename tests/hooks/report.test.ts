import { expect, test } from "bun:test";
import { createReportGate, judgeReport } from "../../src/hooks/report.js";
import { resolveConfig } from "../../src/lib/config.js";
import type { Answers } from "../../src/lib/jev.js";
import type { SessionState } from "../../src/lib/state.js";
import { assistant, fakeDecider, liveOperation, memoryState, noul, user } from "../helpers.js";

const answers = (outcome: number, unfinished: number): Answers => ({ outcome: noul(outcome), unfinished: noul(unfinished) });
const GOOD = answers(0.9, 0.1);
const VAGUE = answers(0.1, 0.1);
const PARTIAL = answers(0.9, 0.9);

test("judgeReport asks for a revision when the report is unfinished or states no outcome", () => {
  expect(judgeReport(GOOD, 0.5)).toEqual({ action: "none", reason: "usable report" });
  expect(judgeReport(VAGUE, 0.5)).toMatchObject({ action: "revise", reason: "no-outcome" });
  expect(judgeReport(PARTIAL, 0.5)).toMatchObject({ action: "revise", reason: "unfinished" });
  expect(judgeReport({ outcome: noul(1) }, 0.5)).toEqual({ action: "none", reason: "incomplete answers" });
});

function harness(decided: Answers | undefined, kind: "root" | "child" | "unknown" = "child", sessions: SessionState = memoryState()) {
  const nudges: string[] = [];
  const state = { messages: [user("u1", "Find where retries are implemented"), assistant("I looked around.")] as unknown[] };
  const decider = fakeDecider(decided);
  const { operation, cancel } = liveOperation("ses_child");
  const raw = createReportGate({
    config: resolveConfig({}, {}).reportGate,
    decider,
    sessions: { context: async () => state.messages },
    lookup: async () => ({ kind, parentID: kind === "child" ? "ses_parent" : undefined, directory: "/repo" }),
    state: sessions,
    nudge: async (_sessionID, text) => {
      nudges.push(text);
    },
  });
  const gate = (event: Parameters<typeof raw>[0]) => raw(event, operation);
  return { gate, nudges, decider, state, sessions, cancel };
}

const idle = { sessionID: "ses_child", background: [] };

test("a weak subagent report is sent back once per brief, with the task and report as evidence", async () => {
  const { gate, nudges, decider, state } = harness(VAGUE);
  expect(await gate(idle)).toMatchObject({ action: "revise", reason: "no-outcome" });
  expect(decider.calls[0]?.state).toEqual({ task: "Find where retries are implemented", report: "I looked around." });
  expect(await gate(idle)).toEqual({ action: "none", reason: "already revised" });
  expect(nudges).toHaveLength(1);

  state.messages = [...state.messages, user("u2", "Also check the upload path"), assistant("Hmm.")];
  expect((await gate(idle)).action).toBe("revise");
  expect(nudges).toHaveLength(2);
});

test("usable reports, root sessions, unknown sessions, and outages are left alone", async () => {
  for (const h of [harness(GOOD), harness(VAGUE, "root"), harness(VAGUE, "unknown"), harness(undefined)]) {
    expect((await h.gate(idle)).action).toBe("none");
    expect(h.nudges).toHaveLength(0);
  }
  const root = harness(VAGUE, "root");
  await root.gate(idle);
  expect(root.decider.calls).toHaveLength(0);
});

test("an empty report is sent back without asking the model", async () => {
  const h = harness(GOOD);
  h.state.messages = [user("u1", "Find where retries are implemented"), { type: "assistant", content: [], finish: "stop" }];
  expect(await h.gate(idle)).toMatchObject({ action: "revise", reason: "no-outcome" });
  expect(h.decider.calls).toHaveLength(0);
  expect(h.nudges).toHaveLength(1);
});

test("the one-revision limit survives a rebuilt gate, and a paused parent pauses its subagents", async () => {
  const sessions = memoryState();
  expect((await harness(VAGUE, "child", sessions).gate(idle)).action).toBe("revise");
  expect(await harness(VAGUE, "child", sessions).gate(idle)).toEqual({ action: "none", reason: "already revised" });

  const paused = memoryState();
  await paused.update("ses_parent", { paused: true });
  const h = harness(VAGUE, "child", paused);
  expect(await h.gate(idle)).toEqual({ action: "none", reason: "paused" });
  expect(h.decider.calls).toHaveLength(0);
});

test("a report is not sent back into a subagent that was stopped", async () => {
  const h = harness(VAGUE);
  h.cancel();
  expect(await h.gate(idle)).toEqual({ action: "none", reason: "cancelled" });
  expect(h.nudges).toHaveLength(0);
});

test("a subagent session paused itself, or a parent paused while the model decides, gets no revision", async () => {
  const own = memoryState();
  await own.update("ses_child", { paused: true });
  expect(await harness(VAGUE, "child", own).gate(idle)).toEqual({ action: "none", reason: "paused" });

  const sessions = memoryState();
  const h = harness(VAGUE, "child", sessions);
  const ask = h.decider.ask.bind(h.decider);
  h.decider.ask = async (state, questions) => {
    await sessions.update("ses_parent", { paused: true });
    return ask(state, questions);
  };
  expect(await h.gate(idle)).toEqual({ action: "none", reason: "paused" });
  expect(h.nudges).toHaveLength(0);
  expect((await sessions.read("ses_child")).revised).toBeUndefined();
});
