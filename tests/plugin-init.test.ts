import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/lib/config.js";
import plugin from "../src/index.js";
import { BoundedMap, createRootCheck, lastTurn } from "../src/lib/sessions.js";
import { assistant, user } from "./helpers.js";

const saved = { key: process.env.FOREMAN_JEV_API_KEY, dir: process.env.OPENCODE_CONFIG_DIR, data: process.env.XDG_DATA_HOME };
let root: string;

// Point the plugin at empty config directories so the developer's own foreman.json cannot leak into a test.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foreman-test-"));
  mkdirSync(join(root, "global"));
  mkdirSync(join(root, "project", ".opencode"), { recursive: true });
  process.env.OPENCODE_CONFIG_DIR = join(root, "global");
  process.env.XDG_DATA_HOME = join(root, "data");
  delete process.env.FOREMAN_JEV_API_KEY;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [name, value] of [["FOREMAN_JEV_API_KEY", saved.key], ["OPENCODE_CONFIG_DIR", saved.dir], ["XDG_DATA_HOME", saved.data]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Setup = Parameters<typeof plugin.setup>[0];

interface Draft {
  name: string;
  mode: string;
  hidden: boolean;
  permissions: unknown[];
  model?: unknown;
  system?: string;
}

function fakeContext(options: Record<string, unknown>) {
  const hooks: string[] = [];
  const commands: string[] = [];
  const replay = { agents: () => {}, commands: () => {} };
  const rpc: { status: (input: unknown) => Promise<unknown>; events: string[] } = { status: async () => undefined, events: [] };
  const agents = new Map<string, Draft>([["explore", { name: "Explore", mode: "subagent", hidden: false, permissions: [] }]]);
  const state: { defaultAgent?: string | undefined } = {};
  const hook = async (name: string) => {
    hooks.push(name);
    return { dispose: async () => {} };
  };
  const editor = {
    get: (id: string) => agents.get(id),
    update: (id: string, update: (agent: Draft) => void) => {
      const agent = agents.get(id) ?? { name: id, mode: "primary", hidden: false, permissions: [] };
      update(agent);
      agents.set(id, agent);
    },
    remove: (id: string) => void agents.delete(id),
    default: (id: string | undefined) => {
      state.defaultAgent = id;
    },
  };
  const ctx = {
    options,
    location: { directory: join(root, "project") },
    agent: {
      transform: async (callback: (e: typeof editor) => void) => {
        replay.agents = () => callback(editor);
        replay.agents();
        return { dispose: async () => {} };
      },
      reload: async () => replay.agents(),
    },
    rpc: {
      register: async (_definition: unknown, handlers: { status: (input: unknown) => Promise<unknown> }) => {
        rpc.status = handlers.status;
        return { dispose: async () => {}, events: { emit: async (name: string) => void rpc.events.push(name) } };
      },
    },
    model: { list: async () => [] },
    session: { hook, get: async () => ({}), context: async () => [], synthetic: async () => ({}) },
    permission: { hook },
    tool: { hook },
    command: {
      transform: async (callback: (e: { add(command: { name: string }): void }) => void) => {
        replay.commands = () => {
          commands.length = 0;
          callback({ add: (command) => void commands.push(command.name) });
        };
        replay.commands();
        return { dispose: async () => {} };
      },
      reload: async () => replay.commands(),
    },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
  } as unknown as Setup;
  return { ctx, hooks, agents, state, commands, rpc };
}

// Hooks are always registered and consult the current config when they fire, so a config change needs no re-registration.
const ALL_HOOKS = ["execute.before", "context", "experimental.idle", "prompt", "evaluate"];

test("without an API key the agents are registered and the gates are not", async () => {
  const { ctx, hooks, agents, commands } = fakeContext({});
  const cleanup = await plugin.setup(ctx);
  expect(hooks).toEqual(ALL_HOOKS);
  expect(commands).toEqual(["handoff", "stop-work", "plan", "start-work", "review-work"]);
  expect(agents.has("orchestrator")).toBe(true);
  expect(agents.get("orchestrator")?.model).toBeUndefined();
  cleanup?.();
});

test("models come from the global file, then the project file, over plugin options", async () => {
  writeFileSync(
    join(root, "global", "foreman.jsonc"),
    `{
      // tiers
      "models": { "fast": "anthropic/claude-haiku-5-5#low", "lead": "anthropic/claude-opus-5-5#high" },
      "defaultAgent": "orchestrator",
    }`,
  );
  writeFileSync(
    join(root, "project", ".opencode", "foreman.json"),
    JSON.stringify({ agents: { worker: { model: "litellm/chatgpt/gpt-6.1-sol#high" } }, models: { lead: "openai/gpt-6-astra" } }),
  );
  const { ctx, agents, state } = fakeContext({ models: { lead: "x/ignored", standard: "anthropic/claude-sonnet-5-5#medium" } });
  const cleanup = await plugin.setup(ctx);
  expect(agents.get("orchestrator")?.model).toEqual({ providerID: "openai", id: "gpt-6-astra" });
  expect(agents.get("worker")?.model).toEqual({ providerID: "litellm", id: "chatgpt/gpt-6.1-sol", variant: "high" });
  expect(agents.get("tester")?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5", variant: "medium" });
  expect(agents.get("explore")?.model).toEqual({ providerID: "anthropic", id: "claude-haiku-5-5", variant: "low" });
  expect(agents.get("explore")?.system).toBeUndefined();
  expect(state.defaultAgent).toBe("orchestrator");
  cleanup?.();
});

test("registers every hook once and reports which gates the config turned on", async () => {
  const defaults = fakeContext({ jev: { apiKey: "k" } });
  const cleanup = await plugin.setup(defaults.ctx);
  expect(defaults.hooks).toEqual(ALL_HOOKS);
  expect(typeof cleanup).toBe("function");
  cleanup?.();

  const none = fakeContext({
    jev: { apiKey: "k" },
    bundledAgents: false,
    commands: false,
    doneGate: { enabled: false },
    reportGate: { enabled: false },
    intentGate: { enabled: false },
    loopGuard: { enabled: false },
    plans: { enabled: false },
  });
  await plugin.setup(none.ctx);
  expect(none.commands).toEqual([]);
  expect(none.agents.has("orchestrator")).toBe(false);
  expect(await none.rpc.status({})).toMatchObject({
    plan: null,
    decisions: [],
    gates: { done: false, report: false, intent: false, approval: false, loop: false },
    decisionModel: true,
    logFile: join(root, "data", "opencode", "foreman", "decisions.jsonl"),
  });
  expect(none.hooks).toEqual(ALL_HOOKS);
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
  expect(config.doneGate).toEqual({ enabled: true, maxContinuations: 2, threshold: 0.5, checks: [], checkTimeoutMs: 120_000 });
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

test("editing a config file applies new models, agents, and commands without a restart", async () => {
  const { ctx, agents, commands, rpc } = fakeContext({});
  const cleanup = await plugin.setup(ctx);
  expect(agents.get("worker")?.model).toBeUndefined();
  expect(commands).toContain("handoff");

  writeFileSync(join(root, "global", "foreman.jsonc"), `{ "models": { "standard": "anthropic/claude-sonnet-5-5#medium" }, "commands": false }`);
  for (let waited = 0; waited < 3_000 && !rpc.events.includes("config"); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));

  expect(rpc.events).toContain("config");
  expect(agents.get("worker")?.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5", variant: "medium" });
  expect(commands).toEqual([]);
  expect(await rpc.status({})).toMatchObject({ configFiles: [join(root, "global", "foreman.jsonc")] });
  cleanup?.();
});

test("the status view is seeded from the decision log for this directory", async () => {
  const logDir = join(root, "data", "opencode", "foreman");
  mkdirSync(logDir, { recursive: true });
  const entry = (directory: string, reason: string) =>
    JSON.stringify({ time: "2026-11-16T05:00:00.000Z", sessionID: "ses_1", gate: "done", action: "none", reason, directory, answers: { work: 0.9 } });
  writeFileSync(join(logDir, "decisions.jsonl"), [entry(join(root, "project"), "older"), entry("/elsewhere", "other"), entry(join(root, "project"), "newer")].join("\n") + "\n");
  const { ctx, rpc } = fakeContext({});
  const cleanup = await plugin.setup(ctx);
  const status = (await rpc.status({ sessionID: "ses_1" })) as { decisions: Array<{ reason: string; time: number }> };
  expect(status.decisions.map((decision) => decision.reason)).toEqual(["newer", "older"]);
  expect(status.decisions[0]?.time).toBe(Date.parse("2026-11-16T05:00:00.000Z"));
  cleanup?.();
});
