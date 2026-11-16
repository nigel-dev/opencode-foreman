import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/lib/config.js";
import plugin from "../src/index.js";
import { BoundedMap, createSessionLookup, lastTurn } from "../src/lib/sessions.js";
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

interface Registered {
  name: string;
  execute(input: { sessionID: string; prompt: Record<string, unknown>; delivery: string }): Promise<void>;
}

function fakeContext(options: Record<string, unknown>, stored = new Map<string, unknown>()) {
  const hooks: string[] = [];
  const commands: string[] = [];
  const registered = new Map<string, Registered>();
  const calls: Array<Record<string, unknown>> = [];
  const pending: Array<Record<string, unknown>> = [];
  let wake = () => {};
  const emitEvent = async (event: Record<string, unknown>) => {
    pending.push(event);
    wake();
    // Let the plugin's subscription loop take the event and finish handling it.
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  };
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
    session: {
      hook,
      get: async () => ({}),
      context: async () => [],
      synthetic: async () => ({}),
      prompt: async (input: unknown) => void calls.push({ prompt: input }),
      switchAgent: async (input: unknown) => void calls.push({ switchAgent: input }),
      switchModel: async (input: unknown) => void calls.push({ switchModel: input }),
    },
    event: {
      // An event stream the test can push into; it ends when the plugin unloads.
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Record<string, unknown>>> => {
            while (pending.length === 0) {
              if (signal.aborted) return { done: true, value: undefined };
              await new Promise<void>((resolve) => {
                wake = resolve;
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            return { done: false, value: pending.shift() as Record<string, unknown> };
          },
        }),
      }),
    },
    permission: { hook },
    tool: { hook },
    command: {
      transform: async (callback: (e: { add(command: Registered): void }) => void) => {
        replay.commands = () => {
          commands.length = 0;
          registered.clear();
          callback({
            add: (command) => {
              commands.push(command.name);
              registered.set(command.name, command);
            },
          });
        };
        replay.commands();
        return { dispose: async () => {} };
      },
      reload: async () => replay.commands(),
    },
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => void stored.set(key, value),
      remove: async (key: string) => void stored.delete(key),
    },
  } as unknown as Setup;
  return { ctx, hooks, agents, state, commands, rpc, registered, calls, stored, emitEvent };
}

// Hooks are always registered and consult the current config when they fire, so a config change needs no re-registration.
const ALL_HOOKS = ["execute.before", "context", "experimental.idle", "prompt", "evaluate"];

test("without an API key the agents are registered and the gates are not", async () => {
  const { ctx, hooks, agents, commands } = fakeContext({});
  const cleanup = await plugin.setup(ctx);
  expect(hooks).toEqual(ALL_HOOKS);
  expect(commands).toEqual(["handoff", "stop-work", "foreman-pause", "foreman-resume", "plan", "start-work", "review-work"]);
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
  // The key can only come from the environment or the global Foreman file, never from plugin options.
  process.env.FOREMAN_JEV_API_KEY = "k";
  const defaults = fakeContext({ jev: { apiKey: "ignored" } });
  const cleanup = await plugin.setup(defaults.ctx);
  expect(defaults.hooks).toEqual(ALL_HOOKS);
  expect(typeof cleanup).toBe("function");
  cleanup?.();

  const none = fakeContext({
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
  expect(lastTurn([])).toBeUndefined();
});

test("lastTurn keeps an assistant reply whose user message was compacted away", () => {
  expect(lastTurn([{ type: "compaction" }, assistant("still here")])).toEqual({ userID: undefined, request: undefined, reply: "still here", failed: false });
  expect(lastTurn([user("u1", "hi")])).toBeUndefined();
  expect(lastTurn([user("u1", "hi"), { type: "assistant", content: [], finish: "stop" }])?.reply).toBe("");
});

test("session lookup reports parents and treats failures as unknown", async () => {
  const lookup = createSessionLookup({
    get: async ({ sessionID }) => {
      if (sessionID === "broken") throw new Error("gone");
      return sessionID === "child" ? { parentID: "ses_parent", location: { directory: "/repo" } } : {};
    },
  });
  expect(await lookup("root")).toEqual({ kind: "root", parentID: undefined, directory: undefined });
  expect(await lookup("child")).toEqual({ kind: "child", parentID: "ses_parent", directory: "/repo" });
  expect((await lookup("broken")).kind).toBe("unknown");
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

test("/plan keeps attachments, drops their text offsets, and switches to the planner's model", async () => {
  const { ctx, registered, calls } = fakeContext({ models: { reasoning: "anthropic/claude-fable-5-2#high" } });
  const cleanup = await plugin.setup(ctx);
  await registered.get("plan")?.execute({
    sessionID: "ses_1",
    prompt: {
      text: " add OAuth ",
      files: [{ uri: "file:///shot.png", mention: { start: 0, end: 4, text: "@shot" } }],
      skills: [{ id: "frontend" }],
    },
    delivery: "queue",
  });
  expect(calls).toEqual([
    { switchAgent: { sessionID: "ses_1", agent: "planner" } },
    { switchModel: { sessionID: "ses_1", model: { providerID: "anthropic", id: "claude-fable-5-2", variant: "high" } } },
    { prompt: { sessionID: "ses_1", text: "add OAuth", files: [{ uri: "file:///shot.png" }], skills: [{ id: "frontend" }], delivery: "queue" } },
  ]);
  cleanup?.();
});

test("/foreman-pause is stored, shown in the status, and survives a plugin reload", async () => {
  const first = fakeContext({});
  const cleanup = await plugin.setup(first.ctx);
  await first.registered.get("foreman-pause")?.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" });
  expect(await first.rpc.status({ sessionID: "ses_1" })).toMatchObject({ paused: true, check: null, health: { state: "off" } });
  expect(await first.rpc.status({ sessionID: "ses_2" })).toMatchObject({ paused: false });
  expect(first.calls).toEqual([]);
  cleanup?.();

  // A second plugin instance over the same storage, as after OpenCode reloads the plugin.
  const second = fakeContext({}, first.stored);
  const cleanupSecond = await plugin.setup(second.ctx);
  expect(await second.rpc.status({ sessionID: "ses_1" })).toMatchObject({ paused: true });
  await second.registered.get("foreman-resume")?.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "steer" });
  expect(await second.rpc.status({ sessionID: "ses_1" })).toMatchObject({ paused: false });
  cleanupSecond?.();
});

test("a request is recorded when the session accepts it, not when it is merely submitted", async () => {
  const { ctx, stored, emitEvent } = fakeContext({});
  const cleanup = await plugin.setup(ctx);
  const here = { directory: join(root, "project") };
  const enqueued = (sessionID: string, inboxID: string, item: Record<string, unknown>, location = here) => ({
    type: "session.inbox.enqueued",
    location,
    data: { sessionID, inboxID, item },
  });

  await emitEvent(enqueued("ses_1", "msg_1", { type: "user", payload: { text: "Add a toggle" }, delivery: "steer" }));
  expect(stored.get("session/ses_1/request")).toEqual({ id: "msg_1", text: "Add a toggle" });

  // A nudge from a gate and a session in another location do not replace it.
  await emitEvent(enqueued("ses_1", "msg_2", { type: "synthetic", payload: { text: "Continue" }, delivery: "steer" }));
  await emitEvent(enqueued("ses_9", "msg_3", { type: "user", payload: { text: "Elsewhere" }, delivery: "steer" }, { directory: "/elsewhere" }));
  expect(stored.get("session/ses_1/request")).toEqual({ id: "msg_1", text: "Add a toggle" });
  expect(stored.has("session/ses_9/request")).toBe(false);

  await emitEvent({ type: "session.deleted", location: here, data: { sessionID: "ses_1" } });
  expect(stored.has("session/ses_1/request")).toBe(false);
  cleanup?.();
});

test("a config file that cannot be parsed keeps the settings already in use", async () => {
  writeFileSync(join(root, "global", "foreman.jsonc"), `{ "commands": false }`);
  const { ctx, commands, rpc } = fakeContext({});
  const cleanup = await plugin.setup(ctx);
  expect(commands).toEqual([]);

  writeFileSync(join(root, "global", "foreman.jsonc"), `{ "commands": fal`);
  for (let waited = 0; waited < 3_000 && !rpc.events.includes("config"); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(rpc.events).toContain("config");
  // Without the file the default would turn the commands back on.
  expect(commands).toEqual([]);
  cleanup?.();
});
