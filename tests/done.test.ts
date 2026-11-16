import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config.js";
import { createDoneGate, judge } from "../src/gates/done.js";
import type { Answers } from "../src/jev.js";
import { assistant, fakeDecider, noul, user } from "./helpers.js";

function answers(values: { work: number; blocked: number; unfinished: number; claimsDone: number; verified: number; waived?: number }): Answers {
  return Object.fromEntries(Object.entries({ waived: 0, ...values }).map(([name, value]) => [name, noul(value)]));
}

const UNVERIFIED = answers({ work: 0.9, blocked: 0.1, unfinished: 0.1, claimsDone: 0.9, verified: 0.1 });
const UNFINISHED = answers({ work: 0.9, blocked: 0.1, unfinished: 0.9, claimsDone: 0.1, verified: 0.1 });
const DONE = answers({ work: 0.9, blocked: 0.1, unfinished: 0.1, claimsDone: 0.9, verified: 0.9 });

test("judge continues only for requested work that is unfinished or unverified", () => {
  expect(judge(UNVERIFIED, 0.5)).toMatchObject({ action: "continue", reason: "unverified" });
  expect(judge(UNFINISHED, 0.5)).toMatchObject({ action: "continue", reason: "unfinished" });
  expect(judge(DONE, 0.5)).toEqual({ action: "none", reason: "done" });
  expect(judge(answers({ work: 0.9, blocked: 0, unfinished: 0, claimsDone: 0.9, verified: 0, waived: 0.9 }), 0.5)).toEqual({
    action: "none",
    reason: "done",
  });
  expect(judge(answers({ work: 0.1, blocked: 0, unfinished: 0.9, claimsDone: 0.9, verified: 0 }), 0.5).action).toBe("none");
  expect(judge(answers({ work: 0.9, blocked: 0.9, unfinished: 0.9, claimsDone: 0, verified: 0 }), 0.5).action).toBe("none");
  expect(judge({ work: noul(1) }, 0.5)).toEqual({ action: "none", reason: "incomplete answers" });
});

function harness(decided: Answers | undefined, options: { root?: boolean; messages?: unknown[]; max?: number } = {}) {
  const nudges: Array<{ sessionID: string; text: string }> = [];
  const state = { messages: options.messages ?? [user("u1", "Add a toggle"), assistant("Done, toggle added.")] };
  const decider = fakeDecider(decided);
  const gate = createDoneGate({
    config: resolveConfig({ doneGate: { maxContinuations: options.max ?? 2 } }).doneGate,
    decider,
    sessions: { context: async () => state.messages },
    isRoot: async () => options.root ?? true,
    nudge: async (sessionID, text) => {
      nudges.push({ sessionID, text });
    },
  });
  return { gate, nudges, decider, state };
}

const idle = { sessionID: "ses_1", background: [] };

test("nudges an unverified completion and sends the request with the final message", async () => {
  const { gate, nudges, decider } = harness(UNVERIFIED);
  expect(await gate(idle)).toMatchObject({ action: "continue", reason: "unverified" });
  expect(nudges).toHaveLength(1);
  expect(nudges[0]?.sessionID).toBe("ses_1");
  expect(decider.calls[0]?.state).toEqual({ request: "Add a toggle", final_message: "Done, toggle added." });
});

test("stops nudging at the limit and starts again for a new user request", async () => {
  const { gate, nudges, state } = harness(UNFINISHED, { max: 2 });
  await gate(idle);
  await gate(idle);
  expect(await gate(idle)).toEqual({ action: "none", reason: "continuation limit reached" });
  expect(nudges).toHaveLength(2);
  state.messages = [...state.messages, user("u2", "Now add tests"), assistant("Still working on tests.")];
  expect((await gate(idle)).action).toBe("continue");
  expect(nudges).toHaveLength(3);
});

test("does nothing without asking when the session is not eligible", async () => {
  const cases = [
    { h: harness(UNVERIFIED, { root: false }), event: idle, reason: "not a root session" },
    { h: harness(UNVERIFIED), event: { sessionID: "ses_1", background: [{ sessionID: "ses_1" }] }, reason: "background work running" },
    { h: harness(UNVERIFIED, { messages: [user("u1", "hi")] }), event: idle, reason: "no completed turn" },
    {
      h: harness(UNVERIFIED, { messages: [user("u1", "hi"), assistant("partial", { finish: "error" })] }),
      event: idle,
      reason: "turn failed",
    },
  ];
  for (const { h, event, reason } of cases) {
    expect(await h.gate(event)).toEqual({ action: "none", reason });
    expect(h.decider.calls).toHaveLength(0);
    expect(h.nudges).toHaveLength(0);
  }
});

test("a descendant's background work does not defer the gate", async () => {
  const { gate, nudges } = harness(UNVERIFIED);
  await gate({ sessionID: "ses_1", background: [{ sessionID: "ses_child" }] });
  expect(nudges).toHaveLength(1);
});

test("does nothing when the work is done or the decision model is unavailable", async () => {
  for (const decided of [DONE, undefined]) {
    const { gate, nudges } = harness(decided);
    expect((await gate(idle)).action).toBe("none");
    expect(nudges).toHaveLength(0);
  }
});
