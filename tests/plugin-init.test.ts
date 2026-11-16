import { afterEach, expect, test } from "bun:test";
import { resolveConfig } from "../src/lib/config.js";
import plugin from "../src/index.js";
import { BoundedMap, createRootCheck, lastTurn } from "../src/lib/sessions.js";
import { assistant, user } from "./helpers.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.FOREMAN_JEV_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.FOREMAN_JEV_API_KEY;
  else process.env.FOREMAN_JEV_API_KEY = originalKey;
});

type Setup = Parameters<typeof plugin.setup>[0];

function fakeContext(options: Record<string, unknown>) {
  const hooks: string[] = [];
  const hook = async (name: string) => {
    hooks.push(name);
    return { dispose: async () => {} };
  };
  const ctx = {
    options,
    session: { hook, get: async () => ({}), context: async () => [], synthetic: async () => ({}) },
    permission: { hook },
    storage: { set: async () => {} },
  } as unknown as Setup;
  return { ctx, hooks };
}

test("registers nothing without an API key", async () => {
  delete process.env.FOREMAN_JEV_API_KEY;
  const { ctx, hooks } = fakeContext({});
  expect(await plugin.setup(ctx)).toBeUndefined();
  expect(hooks).toEqual([]);
});

test("registers the done and intent gates by default and approval only when enabled", async () => {
  const defaults = fakeContext({ jev: { apiKey: "k" } });
  const cleanup = await plugin.setup(defaults.ctx);
  expect(defaults.hooks).toEqual(["experimental.idle", "prompt", "context"]);
  expect(typeof cleanup).toBe("function");

  const all = fakeContext({ jev: { apiKey: "k" }, approval: { enabled: true } });
  await plugin.setup(all.ctx);
  expect(all.hooks).toEqual(["experimental.idle", "prompt", "context", "evaluate"]);

  const none = fakeContext({ jev: { apiKey: "k" }, doneGate: { enabled: false }, intentGate: { enabled: false } });
  await plugin.setup(none.ctx);
  expect(none.hooks).toEqual([]);
});

test("config falls back to defaults for missing or invalid values and reads the environment", () => {
  const config = resolveConfig(
    { doneGate: { threshold: 5, maxContinuations: "many" }, approval: { prefixes: ["git status", 3, ""] } },
    { FOREMAN_JEV_API_KEY: "env-key", FOREMAN_JEV_URL: "http://127.0.0.1:4000/v1/systemone", FOREMAN_JEV_MODEL: "typesafe/jev-1.14.0" },
  );
  expect(config.jev).toEqual({
    url: "http://127.0.0.1:4000/v1/systemone",
    apiKey: "env-key",
    model: "typesafe/jev-1.14.0",
    timeoutMs: 3_000,
  });
  expect(config.doneGate).toEqual({ enabled: true, maxContinuations: 2, threshold: 0.5 });
  expect(config.approval).toMatchObject({ enabled: false, dryRun: true, riskThreshold: 0.2, prefixes: ["git status"] });
  expect(resolveConfig({ jev: { apiKey: "option-key" } }, { FOREMAN_JEV_API_KEY: "env-key" }).jev.apiKey).toBe("option-key");
});

test("lastTurn returns the latest request and the final assistant text after it", () => {
  const turn = lastTurn([
    user("u1", "first"),
    assistant("old reply"),
    user("u2", "second"),
    assistant("thinking"),
    { type: "assistant", content: [{ type: "tool", name: "shell" }], finish: "tool-calls" },
    assistant("final reply"),
  ]);
  expect(turn).toEqual({ userID: "u2", request: "second", reply: "final reply", failed: false });
  expect(lastTurn([assistant("orphan")])).toBeUndefined();
});

test("root check caches results and treats lookup failures as not root", async () => {
  let lookups = 0;
  const isRoot = createRootCheck({
    get: async ({ sessionID }) => {
      lookups++;
      if (sessionID === "broken") throw new Error("gone");
      return sessionID === "child" ? { parentID: "ses_parent" } : {};
    },
  });
  expect(await isRoot("root")).toBe(true);
  expect(await isRoot("root")).toBe(true);
  expect(await isRoot("child")).toBe(false);
  expect(await isRoot("broken")).toBe(false);
  expect(lookups).toBe(3);
});

test("BoundedMap evicts the oldest entry past its limit", () => {
  const map = new BoundedMap<string, number>(2);
  map.set("a", 1);
  map.set("b", 2);
  map.set("a", 3);
  map.set("c", 4);
  expect([map.get("a"), map.get("b"), map.get("c"), map.size]).toEqual([3, undefined, 4, 2]);
});
