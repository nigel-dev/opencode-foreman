import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionLog, defaultLogPath, flattenAnswers, readRecentEntries } from "../../src/lib/log.js";
import { traced, withTrace } from "../../src/lib/trace.js";
import { fakeDecider, noul } from "../helpers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foreman-log-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test("defaultLogPath follows XDG_DATA_HOME and falls back to ~/.local/share", () => {
  expect(defaultLogPath({ XDG_DATA_HOME: "/data" })).toBe("/data/opencode/foreman/decisions.jsonl");
  expect(defaultLogPath({ XDG_DATA_HOME: "relative" })).toMatch(/\.local\/share\/opencode\/foreman\/decisions\.jsonl$/);
});

test("writes one JSON object per line, in order, creating the directory", async () => {
  const path = join(root, "nested", "decisions.jsonl");
  const log = createDecisionLog({ enabled: true, path, maxBytes: 1_000_000 });
  await Promise.all([log.write({ n: 1 }), log.write({ n: 2 }), log.write({ n: 3, text: "a\nb" })]);
  expect(lines(path)).toEqual([{ n: 1 }, { n: 2 }, { n: 3, text: "a\nb" }]);
});

test("rotates to .1 once the file passes maxBytes and keeps writing", async () => {
  const path = join(root, "decisions.jsonl");
  const log = createDecisionLog({ enabled: true, path, maxBytes: 100 });
  for (let n = 0; n < 12; n++) await log.write({ n, padding: "x".repeat(20) });
  expect(existsSync(`${path}.1`)).toBe(true);
  expect(lines(path).at(-1)).toMatchObject({ n: 11 });
  expect(readFileSync(path, "utf8").length).toBeLessThan(200);
});

test("a disabled log writes nothing, and an unwritable path does not throw", async () => {
  const path = join(root, "off.jsonl");
  await createDecisionLog({ enabled: false, path, maxBytes: 100 }).write({ n: 1 });
  expect(existsSync(path)).toBe(false);
  await createDecisionLog({ enabled: true, path: "/dev/null/nope/decisions.jsonl", maxBytes: 100 }).write({ n: 1 });
});

test("flattenAnswers keeps probabilities, choices with confidence, and scores", () => {
  expect(
    flattenAnswers({ a: noul(0.2), b: { type: "choice", choice: "implement", confidence: 0.9 }, c: { type: "score", score: 1.4, confidence: 0.5 } }),
  ).toEqual({ a: 0.2, b: "implement@0.9", c: 1.4 });
});

test("withTrace returns the answers a traced decider gave during that run only", async () => {
  const decider = traced(fakeDecider({ q: noul(0.7) }));
  const asked = await withTrace(async () => {
    await decider.ask("state", {});
    return "done";
  });
  expect(asked.result).toBe("done");
  expect(asked.answers).toEqual({ q: noul(0.7) });
  expect(typeof asked.elapsedMs).toBe("number");

  const silent = await withTrace(async () => "no question");
  expect(silent.answers).toBeUndefined();
  expect(await decider.ask("outside a trace", {})).toEqual({ q: noul(0.7) });
});

test("readRecentEntries returns the newest entries first and skips malformed lines", async () => {
  const path = join(root, "decisions.jsonl");
  const log = createDecisionLog({ enabled: true, path, maxBytes: 1_000_000 });
  for (let n = 0; n < 5; n++) await log.write({ n });
  const { appendFileSync } = await import("node:fs");
  appendFileSync(path, "{ cut short\n[1]\n");
  expect(await readRecentEntries(path, 3)).toEqual([{ n: 4 }, { n: 3 }, { n: 2 }]);
  expect(await readRecentEntries(join(root, "missing.jsonl"), 3)).toEqual([]);
});
