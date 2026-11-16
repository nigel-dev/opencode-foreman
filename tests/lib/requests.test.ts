import { expect, test } from "bun:test";
import { createRequestTracker, inOrder } from "../../src/lib/requests.js";

const settle = async () => {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
};

function gate<T>() {
  let open: (value: T) => void = () => {};
  const wait = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function harness(userText: (sessionID: string, inboxID: string) => Promise<string | undefined>) {
  const cancelled: string[] = [];
  const started: string[] = [];
  const stored = new Map<string, { id: string; text: string }>();
  const tracker = createRequestTracker({
    userText,
    cancelStale: (sessionID) => void cancelled.push(sessionID),
    startRequest: (sessionID) => void started.push(sessionID),
    persist: async (sessionID, request) => void stored.set(sessionID, request),
    report: (error) => {
      throw error;
    },
  });
  return { tracker, cancelled, started, stored };
}

test("gate work is cancelled only at the moment of delivery, never when a slow lookup finishes", async () => {
  const lookup = gate<string | undefined>();
  const h = harness(() => lookup.wait);
  // m1 was queued before a plugin reload, so its text has to be read back.
  h.tracker.delivered("ses_r1", "m1");
  expect(h.cancelled).toEqual(["ses_r1"]);

  // Its own gate may start while the lookup is still waiting; the lookup finishing must not cancel it.
  lookup.open("first");
  await settle();
  expect(h.cancelled).toEqual(["ses_r1"]);
  expect(h.started).toEqual(["ses_r1"]);
  expect(h.stored.get("ses_r1")).toEqual({ id: "m1", text: "first" });
});

test("a slow lookup for an older request does not disturb a newer one", async () => {
  const lookup = gate<string | undefined>();
  const h = harness(() => lookup.wait);
  h.tracker.delivered("ses_r2", "m1");
  h.tracker.enqueued("m2", "second");
  h.tracker.delivered("ses_r2", "m2");
  expect(h.cancelled).toEqual(["ses_r2", "ses_r2"]);
  expect(h.started).toEqual(["ses_r2"]);

  lookup.open("first");
  await settle();
  // Nothing more on behalf of m1, and m2 is what ends up stored.
  expect(h.cancelled).toEqual(["ses_r2", "ses_r2"]);
  expect(h.started).toEqual(["ses_r2"]);
  expect(h.stored.get("ses_r2")).toEqual({ id: "m2", text: "second" });
});

test("a delivered nudge is not a request", async () => {
  const h = harness(async () => undefined);
  h.tracker.delivered("ses_r4", "m1");
  await settle();
  expect(h.started).toEqual([]);
  expect(h.stored.has("ses_r4")).toBe(false);
});

test("work for one session runs in the order it was started, and a failure does not stop the queue", async () => {
  const first = gate<void>();
  const ran: string[] = [];
  const errors: unknown[] = [];
  inOrder("ses_r3", () => first.wait.then(() => void ran.push("first")), (error) => errors.push(error));
  inOrder("ses_r3", () => Promise.reject(new Error("storage failed")), (error) => errors.push(error));
  inOrder("ses_r3", async () => void ran.push("third"), (error) => errors.push(error));
  inOrder("ses_other", async () => void ran.push("other"), (error) => errors.push(error));
  await settle();
  expect(ran).toEqual(["other"]);
  first.open();
  await settle();
  expect(ran).toEqual(["other", "first", "third"]);
  expect(errors).toHaveLength(1);
});
