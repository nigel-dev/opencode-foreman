import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommands } from "../src/commands.js";
import { createPlanStore } from "../src/lib/plans.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foreman-commands-"));
  mkdirSync(join(root, ".foreman", "plans"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function harness(bundledAgents = true, disabled: string[] = []) {
  const data = new Map<string, string>();
  const plans = createPlanStore({
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  });
  const sent: string[] = [];
  const switched: string[] = [];
  const paused: boolean[] = [];
  const commands = createCommands({
    available: (agent) => bundledAgents && !disabled.includes(agent),
    setPaused: async (_sessionID, value) => void paused.push(value),
    plans,
    lookup: async () => ({ kind: "root", parentID: undefined, directory: root }),
    fallbackDirectory: "/elsewhere",
    send: async (_input, text) => void sent.push(text),
    switchAgent: async (_sessionID, agent) => void switched.push(agent),
  });
  const run = async (name: string, text = "") => {
    const command = commands.find((item) => item.name === name);
    if (!command) throw new Error(`no command ${name}`);
    await command.execute({ sessionID: "ses_1", prompt: { text } });
  };
  return { commands, run, sent, switched, plans, paused };
}

test("agent-switching commands are only offered with the bundled agents", () => {
  const names = (bundled: boolean, disabled: string[] = []) => harness(bundled, disabled).commands.map((command) => command.name);
  const always = ["handoff", "stop-work", "foreman-pause", "foreman-resume"];
  expect(names(true)).toEqual([...always, "plan", "start-work", "review-work"]);
  expect(names(false)).toEqual(always);
  expect(names(true, ["planner", "reviewer"])).toEqual([...always, "start-work"]);
});

test("/plan switches to the planner and passes the request through", async () => {
  const { run, sent, switched } = harness();
  await run("plan", "  add OAuth login ");
  await run("plan");
  expect(switched).toEqual(["planner", "planner"]);
  expect(sent[0]).toBe("add OAuth login");
  expect(sent[1]).toContain("Ask me what it is");
});

test("/start-work activates the plan and hands it to the orchestrator", async () => {
  const { run, sent, switched, plans } = harness();
  const path = join(root, ".foreman", "plans", "auth.md");
  writeFileSync(path, "- [ ] a");
  await run("start-work", "auth");
  expect(switched).toEqual(["orchestrator"]);
  expect(sent[0]).toContain(path);
  expect((await plans.active("ses_1"))?.path).toBe(path);
});

test("/start-work with an unknown plan explains and changes nothing", async () => {
  const { run, sent, switched, plans } = harness();
  await run("start-work", "nope");
  expect(switched).toEqual([]);
  expect(sent[0]).toContain('No plan named "nope"');
  expect(await plans.active("ses_1")).toBeUndefined();
});

test("/stop-work clears the active plan and says whether there was one", async () => {
  const { run, sent, plans } = harness();
  const path = join(root, ".foreman", "plans", "auth.md");
  writeFileSync(path, "- [ ] a");
  await plans.activate("ses_1", path);
  await run("stop-work");
  await run("stop-work");
  expect(await plans.active("ses_1")).toBeUndefined();
  expect(sent[0]).toContain(path);
  expect(sent[1]).toContain("not tracking a plan");
});

test("/handoff and /review-work append an optional focus", async () => {
  const { run, sent } = harness();
  await run("handoff");
  await run("handoff", "the auth changes");
  await run("review-work", "error handling");
  expect(sent[0]).toContain("**Next step**");
  expect(sent[0]).not.toContain("Pay particular attention");
  expect(sent[1]).toContain("Pay particular attention to: the auth changes");
  expect(sent[2]).toContain("`reviewer`");
  expect(sent[2]).toContain("focus on: error handling");
});

test("/foreman-pause and /foreman-resume change the pause state and send nothing into the session", async () => {
  const { run, sent, paused } = harness();
  await run("foreman-pause");
  await run("foreman-resume");
  expect(paused).toEqual([true, false]);
  expect(sent).toEqual([]);
});
