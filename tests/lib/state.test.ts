import { expect, test } from "bun:test";
import { createOperations } from "../../src/lib/operations.js";
import { createSessionState, identifyTurn, parseRecord } from "../../src/lib/state.js";
import { memoryStorage } from "../helpers.js";

test("session state merges updates, persists them, and is shared between instances", async () => {
  const storage = memoryStorage();
  const here = createSessionState(storage);
  const there = createSessionState(storage);
  expect(await here.read("ses_1")).toEqual({});

  await here.update("ses_1", { request: { id: "u1", text: "x".repeat(5_000) } });
  await there.update("ses_1", { nudges: { requestID: "u1", count: 1 } });
  await here.update("ses_1", { paused: true });
  const record = await there.read("ses_1");
  expect(record.request?.text.length).toBeLessThanOrEqual(4_001);
  expect(record).toMatchObject({ nudges: { requestID: "u1", count: 1 }, paused: true });

  await there.update("ses_1", { paused: false });
  expect((await here.read("ses_1")).paused).toBeUndefined();
  await here.remove("ses_1");
  expect(await there.read("ses_1")).toEqual({});
});

test("concurrent updates to one session do not lose each other", async () => {
  const state = createSessionState(memoryStorage());
  await Promise.all([state.update("ses_1", { revised: "u1" }), state.update("ses_1", { paused: true }), state.update("ses_1", { nudges: { requestID: "u1", count: 2 } })]);
  expect(await state.read("ses_1")).toEqual({ revised: "u1", paused: true, nudges: { requestID: "u1", count: 2 } });
});

test("parseRecord drops anything malformed", () => {
  expect(parseRecord("x")).toEqual({});
  expect(parseRecord({ request: { id: 1 }, nudges: { requestID: "u1" }, revised: 3, paused: "yes" })).toEqual({});
});

test("identifyTurn prefers the user message in the window and falls back to the recorded request", () => {
  const record = { request: { id: "stored", text: "stored request" } };
  expect(identifyTurn({ userID: "u9", request: "live" }, record)).toEqual({ requestID: "u9", request: "live" });
  expect(identifyTurn({ userID: undefined, request: undefined }, record)).toEqual({ requestID: "stored", request: "stored request" });
  expect(identifyTurn({ userID: undefined, request: undefined }, {})).toBeUndefined();
});

test("operations cancel per session, supersede an earlier run, and cancel everything on unload", () => {
  const operations = createOperations();
  const first = operations.begin("ses_1");
  const other = operations.begin("ses_2");
  const second = operations.begin("ses_1");
  expect(first.live()).toBe(false);
  expect(second.live()).toBe(true);

  // Ending a superseded run must not unregister the one that replaced it.
  first.end();
  expect(operations.cancel("ses_1")).toBe(true);
  expect(second.signal.aborted).toBe(true);
  expect(operations.cancel("ses_1")).toBe(false);

  operations.cancelAll();
  expect(other.live()).toBe(false);

  const finished = operations.begin("ses_3");
  finished.end();
  expect(operations.cancel("ses_3")).toBe(false);
  expect(finished.live()).toBe(true);
});

test("updates from two instances to different fields of one session never overwrite each other", async () => {
  // A storage whose reads and writes interleave: every operation yields first.
  const data = new Map<string, unknown>();
  const slow = {
    get: async (key: string) => (await Promise.resolve(), data.get(key)),
    set: async (key: string, value: unknown) => (await Promise.resolve(), void data.set(key, value)),
    remove: async (key: string) => (await Promise.resolve(), void data.delete(key)),
  };
  const here = createSessionState(slow);
  const there = createSessionState(slow);
  await Promise.all([here.update("ses_1", { paused: true }), there.update("ses_1", { nudges: { requestID: "u1", count: 1 } }), here.update("ses_1", { revised: "u1" })]);
  expect(await here.read("ses_1")).toEqual({ paused: true, nudges: { requestID: "u1", count: 1 }, revised: "u1" });
});
