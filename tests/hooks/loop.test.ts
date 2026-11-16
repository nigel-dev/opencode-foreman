import { expect, test } from "bun:test";
import { createLoopGuard, fingerprint, RepeatedCallError } from "../../src/hooks/loop.js";
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
