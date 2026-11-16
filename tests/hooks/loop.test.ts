import { expect, test } from "bun:test";
import { createLoopGuard, fingerprint, RepeatedCallError, repeatingCycle } from "../../src/hooks/loop.js";
import { resolveConfig } from "../../src/lib/config.js";

const guard = (options: Record<string, unknown> = {}) => createLoopGuard(resolveConfig({ loopGuard: options }, {}).loopGuard);
const call = (tool: string, input: unknown, sessionID = "ses_1") => ({ sessionID, tool, input });

test("fingerprint ignores argument order and distinguishes tools and values", () => {
  expect(fingerprint(call("read", { path: "a", limit: 5 }))).toBe(fingerprint(call("read", { limit: 5, path: "a" })));
  expect(fingerprint(call("read", { path: "a" }))).not.toBe(fingerprint(call("read", { path: "b" })));
  expect(fingerprint(call("read", { path: "a" }))).not.toBe(fingerprint(call("glob", { path: "a" })));
  expect(fingerprint(call("x", { a: [1, { c: 2, b: 1 }] }))).toBe(fingerprint(call("x", { a: [1, { b: 1, c: 2 }] })));
});

test("blocks the call after maxRepeats identical consecutive calls and keeps blocking it", () => {
  const onCall = guard({ maxRepeats: 3 });
  for (let i = 0; i < 3; i++) onCall(call("read", { path: "a" }));
  expect(() => onCall(call("read", { path: "a" }))).toThrow(RepeatedCallError);
  expect(() => onCall(call("read", { path: "a" }))).toThrow("3 times in a row");
});

test("a different call in between resets the count", () => {
  const onCall = guard({ maxRepeats: 2 });
  for (let i = 0; i < 5; i++) {
    onCall(call("shell", { command: "bun test" }));
    onCall(call("edit", { path: "a", n: i }));
  }
  onCall(call("shell", { command: "bun test" }));
  onCall(call("shell", { command: "bun test" }));
  expect(() => onCall(call("shell", { command: "bun test" }))).toThrow(RepeatedCallError);
  onCall(call("read", { path: "a" }));
  onCall(call("shell", { command: "bun test" }));
});

test("sessions are counted separately and ignored tools are never counted", () => {
  const onCall = guard({ maxRepeats: 1, ignore: ["todowrite"] });
  onCall(call("read", { path: "a" }, "ses_1"));
  onCall(call("read", { path: "a" }, "ses_2"));
  for (let i = 0; i < 5; i++) onCall(call("todowrite", {}));
  expect(() => onCall(call("read", { path: "a" }, "ses_1"))).toThrow(RepeatedCallError);
});

test("repeatingCycle finds cycles of one to three calls and nothing in varied history", () => {
  expect(repeatingCycle(["a", "a", "a"], 2)).toBe(1);
  expect(repeatingCycle(["a", "a"], 2)).toBeUndefined();
  expect(repeatingCycle(["x", "a", "b", "a", "b", "a", "b"], 2)).toBe(2);
  expect(repeatingCycle(["a", "b", "c", "a", "b", "c", "a", "b", "c"], 2)).toBe(3);
  expect(repeatingCycle(["a", "b", "a", "c", "a", "b", "a", "d"], 2)).toBeUndefined();
});

test("blocks a short cycle of different calls that keeps repeating", () => {
  const onCall = guard({ maxRepeats: 2 });
  const round = () => {
    onCall(call("read", { path: "a" }));
    onCall(call("read", { path: "b" }));
  };
  round();
  round();
  onCall(call("read", { path: "a" }));
  let error: unknown;
  try {
    onCall(call("read", { path: "b" }));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RepeatedCallError);
  expect((error as RepeatedCallError).cycle).toBe(2);
  expect((error as Error).message).toContain("last 2 tool calls have repeated 2 times");
});

test("an edit-and-test loop with changing edits is never blocked", () => {
  const onCall = guard({ maxRepeats: 2 });
  for (let i = 0; i < 20; i++) {
    onCall(call("edit", { path: "a", newString: `v${i}` }));
    onCall(call("shell", { command: "bun test" }));
  }
});
