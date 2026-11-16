import { expect, test } from "bun:test";
import { resolveConfig } from "../../src/lib/config.js";
import { createDoneGate, judge } from "../../src/hooks/done.js";
import type { CheckResult } from "../../src/lib/checks.js";
import type { Answers } from "../../src/lib/jev.js";
import type { SessionState } from "../../src/lib/state.js";
import { assistant, fakeDecider, liveOperation, memoryState, noul, user } from "../helpers.js";

function answers(values: { work: number; blocked: number; unfinished: number; claimsDone: number; verified: number; waived?: number }): Answers {
  return Object.fromEntries(Object.entries({ waived: 0, ...values }).map(([name, value]) => [name, noul(value)]));
}

const UNVERIFIED = answers({ work: 0.9, blocked: 0.1, unfinished: 0.1, claimsDone: 0.9, verified: 0.1 });
const UNFINISHED = answers({ work: 0.9, blocked: 0.1, unfinished: 0.9, claimsDone: 0.1, verified: 0.1 });
const DONE = answers({ work: 0.9, blocked: 0.1, unfinished: 0.1, claimsDone: 0.9, verified: 0.9 });

test("judge continues only for requested work that is unfinished or unverified", () => {
  expect(judge(UNVERIFIED, 0.5)).toMatchObject({ action: "continue", reason: "unverified" });
  expect(judge(UNFINISHED, 0.5)).toMatchObject({ action: "continue", reason: "unfinished" });
  expect(judge(DONE, 0.5)).toEqual({ action: "none", reason: "done", claimed: true });
  expect(judge(answers({ work: 0.9, blocked: 0, unfinished: 0, claimsDone: 0.9, verified: 0, waived: 0.9 }), 0.5)).toMatchObject({
    action: "none",
    reason: "done",
  });
  expect(judge(answers({ work: 0.1, blocked: 0, unfinished: 0.9, claimsDone: 0.9, verified: 0 }), 0.5).action).toBe("none");
  expect(judge(answers({ work: 0.9, blocked: 0.9, unfinished: 0.9, claimsDone: 0, verified: 0 }), 0.5).action).toBe("none");
  expect(judge({ work: noul(1) }, 0.5)).toEqual({ action: "none", reason: "incomplete answers" });
});

interface Options {
  root?: boolean;
  messages?: unknown[];
  max?: number;
  checks?: CheckResult;
  plan?: { open: number; done: number };
  state?: SessionState;
}

function harness(decided: Answers | undefined, options: Options = {}) {
  const nudges: Array<{ sessionID: string; text: string }> = [];
  const state = { messages: options.messages ?? [user("u1", "Add a toggle"), assistant("Done, toggle added.")] };
  const decider = fakeDecider(decided);
  const ran: string[] = [];
  const onCheck: { current?: () => Promise<void> | void } = {};
  const plan = { current: options.plan };
  const sessions = options.state ?? memoryState();
  const { operation, cancel } = liveOperation();
  const raw = createDoneGate({
    config: resolveConfig({ doneGate: { maxContinuations: options.max ?? 2 } }).doneGate,
    decider,
    sessions: { context: async () => state.messages },
    lookup: async () => ({ kind: (options.root ?? true) ? "root" : "child", parentID: undefined, directory: "/repo" }),
    state: sessions,
    nudge: async (sessionID, text) => {
      nudges.push({ sessionID, text });
    },
    runChecks: options.checks
      ? async (directory) => {
          ran.push(directory);
          await onCheck.current?.();
          return options.checks!;
        }
      : undefined,
    activePlan: async () => (plan.current ? { path: "/repo/.foreman/plans/p.md", content: "", progress: plan.current } : undefined),
    clearPlan: async () => {
      plan.current = undefined;
    },
  });
  const gate = (event: Parameters<typeof raw>[0]) => raw(event, operation);
  return { gate, nudges, decider, state, ran, plan, sessions, cancel, onCheck };
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
  expect(await gate(idle)).toEqual({ action: "exhausted", reason: "unfinished" });
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

const PASS: CheckResult = { passed: ["bun test"], failure: undefined, cancelled: false };
const FAIL: CheckResult = { passed: [], failure: { command: "bun test", status: 1, output: "1 fail: expected 2, got 3" }, cancelled: false };

test("configured checks replace the wording check: a pass ends the turn even when nothing was said about checks", async () => {
  const { gate, nudges, ran } = harness(UNVERIFIED, { checks: PASS });
  expect(await gate(idle)).toEqual({ action: "none", reason: "checks passed" });
  expect(ran).toEqual(["/repo"]);
  expect(nudges).toHaveLength(0);
});

test("a failing check is sent back with its output, even when the assistant said checks passed", async () => {
  const { gate, nudges } = harness(DONE, { checks: FAIL });
  expect(await gate(idle)).toMatchObject({ action: "continue", reason: "checks-failed" });
  expect(nudges[0]?.text).toContain("`bun test` exited with code 1");
  expect(nudges[0]?.text).toContain("expected 2, got 3");
});

test("checks do not run unless the assistant claims completion", async () => {
  const blocked = answers({ work: 0.9, blocked: 0.9, unfinished: 0, claimsDone: 0.9, verified: 0 });
  for (const decided of [UNFINISHED, blocked, answers({ work: 0.1, blocked: 0, unfinished: 0, claimsDone: 0.9, verified: 0 })]) {
    const { gate, ran } = harness(decided, { checks: FAIL });
    await gate(idle);
    expect(ran).toEqual([]);
  }
});

test("an active plan with open tasks keeps the session going, and a finished plan is cleared", async () => {
  const open = harness(DONE, { plan: { open: 2, done: 1 } });
  expect(await open.gate(idle)).toMatchObject({ action: "continue", reason: "plan-open" });
  expect(open.nudges[0]?.text).toContain("2 open tasks");

  const finished = harness(DONE, { plan: { open: 0, done: 3 } });
  expect(await finished.gate(idle)).toEqual({ action: "none", reason: "done" });
  expect(finished.plan.current).toBeUndefined();

  const waiting = harness(answers({ work: 0.9, blocked: 0.9, unfinished: 0, claimsDone: 0, verified: 0 }), { plan: { open: 2, done: 0 } });
  expect((await waiting.gate(idle)).action).toBe("none");
  expect(waiting.nudges).toHaveLength(0);
});

test("failing checks take priority over open plan tasks", async () => {
  const { gate } = harness(DONE, { checks: FAIL, plan: { open: 1, done: 0 } });
  expect(await gate(idle)).toMatchObject({ reason: "checks-failed" });
});

test("after compaction removes the user message, the recorded request is used", async () => {
  const sessions = memoryState();
  await sessions.update("ses_1", { request: { id: "u1", text: "Add a toggle" } });
  const compacted = [{ type: "compaction", summary: "…" }, assistant("Done, toggle added.")];
  const { gate, decider, nudges } = harness(UNVERIFIED, { messages: compacted, state: sessions });
  expect(await gate(idle)).toMatchObject({ action: "continue", reason: "unverified" });
  expect(decider.calls[0]?.state).toEqual({ request: "Add a toggle", final_message: "Done, toggle added." });
  expect(nudges).toHaveLength(1);

  const unknown = harness(UNVERIFIED, { messages: compacted });
  expect(await unknown.gate(idle)).toEqual({ action: "none", reason: "no completed turn" });
});

test("the continuation limit survives a rebuilt gate, and the final result is still checked", async () => {
  const sessions = memoryState();
  const first = harness(DONE, { checks: FAIL, max: 1, state: sessions });
  expect(await first.gate(idle)).toMatchObject({ action: "continue", reason: "checks-failed" });

  // A config reload builds new gates; the count lives in the shared session state.
  const rebuilt = harness(DONE, { checks: FAIL, max: 1, state: sessions });
  expect(await rebuilt.gate(idle)).toEqual({ action: "exhausted", reason: "checks-failed", detail: "bun test" });
  expect(rebuilt.ran).toEqual(["/repo"]);
  expect(rebuilt.nudges).toHaveLength(0);

  const fixed = harness(DONE, { checks: PASS, max: 1, state: sessions, plan: { open: 0, done: 2 } });
  expect(await fixed.gate(idle)).toEqual({ action: "none", reason: "checks passed" });
  expect(fixed.plan.current).toBeUndefined();
});

test("nothing is sent into a session that was stopped while the gate was working", async () => {
  const duringCheck = harness(DONE, { checks: FAIL });
  duringCheck.onCheck.current = () => duringCheck.cancel();
  expect(await duringCheck.gate(idle)).toEqual({ action: "none", reason: "cancelled" });
  expect(duringCheck.nudges).toHaveLength(0);

  const cancelledRun = harness(DONE, { checks: { passed: [], failure: undefined, cancelled: true } });
  expect(await cancelledRun.gate(idle)).toEqual({ action: "none", reason: "cancelled" });

  const beforeNudge = harness(UNFINISHED);
  beforeNudge.cancel();
  expect(await beforeNudge.gate(idle)).toEqual({ action: "none", reason: "cancelled" });
  expect(beforeNudge.nudges).toHaveLength(0);
});

test("a paused session is left alone without asking the model", async () => {
  const sessions = memoryState();
  await sessions.update("ses_1", { paused: true });
  const { gate, decider, nudges } = harness(UNFINISHED, { state: sessions });
  expect(await gate(idle)).toEqual({ action: "none", reason: "paused" });
  expect(decider.calls).toHaveLength(0);
  expect(nudges).toHaveLength(0);
});

test("a run cancelled while the model decides sends nothing and uses none of the allowance", async () => {
  const sessions = memoryState();
  const h = harness(UNFINISHED, { state: sessions, max: 1 });
  const ask = h.decider.ask.bind(h.decider);
  h.decider.ask = async (state, questions) => {
    h.cancel();
    return ask(state, questions);
  };
  expect(await h.gate(idle)).toEqual({ action: "none", reason: "cancelled" });
  expect(h.nudges).toHaveLength(0);
  expect((await sessions.read("ses_1")).nudges).toBeUndefined();

  // The next, uncancelled run still has its one continuation.
  expect((await harness(UNFINISHED, { state: sessions, max: 1 }).gate(idle)).action).toBe("continue");
});
