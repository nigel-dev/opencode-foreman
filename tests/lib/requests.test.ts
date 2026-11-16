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
  const superseded: string[] = [];
  const stored = new Map<string, { id: string; text: string }>();
  const tracker = createRequestTracker({
    userText,
    supersede: (sessionID) => void superseded.push(sessionID),
    persist: async (sessionID, request) => void stored.set(sessionID, request),
    report: (error) => {
      throw error;
    },
  });
  return { tracker, superseded, stored };
}

test("a slow lookup for an older request does not cancel the work of a newer one", async () => {
  const lookup = gate<string | undefined>();
  const h = harness(() => lookup.wait);
  // m1 was queued before a plugin reload, so its text has to be read back; m2 arrives meanwhile.
  h.tracker.delivered("ses_r1", "m1");
  h.tracker.enqueued("m2", "second");
  h.tracker.delivered("ses_r1", "m2");
  expect(h.superseded).toEqual(["ses_r1"]);

  lookup.open("first");
  await settle();
  // No second cancellation on behalf of m1, and m2 is what ends up stored.
  expect(h.superseded).toEqual(["ses_r1"]);
  expect(h.stored.get("ses_r1")).toEqual({ id: "m2", text: "second" });
});

test("a recovered request that is still the current one cancels stale work and is stored", async () => {
  const h = harness(async (_sessionID, inboxID) => (inboxID === "m1" ? "first" : undefined));
  h.tracker.delivered("ses_r2", "m1");
  await settle();
  expect(h.superseded).toEqual(["ses_r2"]);
  expect(h.stored.get("ses_r2")).toEqual({ id: "m1", text: "first" });

  // A delivered nudge is not a request.
  h.tracker.delivered("ses_r2", "m2");
  await settle();
  expect(h.superseded).toEqual(["ses_r2"]);
  expect(h.stored.get("ses_r2")).toEqual({ id: "m1", text: "first" });
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
