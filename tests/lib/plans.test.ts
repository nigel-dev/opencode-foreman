import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../../src/lib/checks.js";
import { createPlanStore, listPlans, planProgress, renderActivePlan, resolvePlan } from "../../src/lib/plans.js";

let root: string;
let plans: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foreman-plans-"));
  plans = join(root, ".foreman", "plans");
  mkdirSync(plans, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function memoryStorage() {
  const data = new Map<string, string>();
  let reads = 0;
  return {
    data,
    reads: () => reads,
    get: async (key: string) => (reads++, data.get(key)),
    set: async (key: string, value: string) => void data.set(key, value),
    remove: async (key: string) => void data.delete(key),
  };
}

test("planProgress counts checkboxes in bullet and numbered lists", () => {
  expect(planProgress("- [ ] a\n- [x] b\n  * [X] c\n1. [ ] d\n- plain\n[ ] not a list item")).toEqual({ open: 2, done: 2 });
  expect(planProgress("# Plan\nNo tasks here.")).toEqual({ open: 0, done: 0 });
});

test("resolvePlan picks the only plan, requires a name among several, and stays inside the plan directory", () => {
  expect(resolvePlan(root, "")).toMatchObject({ found: false });
  writeFileSync(join(plans, "auth.md"), "- [ ] a");
  expect(resolvePlan(root, "")).toEqual({ found: true, name: "auth", path: join(plans, "auth.md") });
  writeFileSync(join(plans, "billing.md"), "- [ ] b");
  utimesSync(join(plans, "auth.md"), new Date(1_000_000), new Date(1_000_000));
  expect(listPlans(root)).toEqual(["billing", "auth"]);
  expect(resolvePlan(root, "")).toMatchObject({ found: false, reason: expect.stringContaining("billing, auth") });
  expect(resolvePlan(root, " auth.md ")).toMatchObject({ found: true, name: "auth" });
  writeFileSync(join(root, ".foreman", "secret.md"), "x");
  for (const bad of ["../secret", "missing", "/etc/passwd", "a b"]) expect(resolvePlan(root, bad)).toMatchObject({ found: false });
});

test("the plan store persists the active plan, reads it fresh, and drops it when the file is gone", async () => {
  const storage = memoryStorage();
  const store = createPlanStore(storage);
  const path = join(plans, "auth.md");
  writeFileSync(path, "- [ ] a\n- [ ] b");

  expect(await store.active("ses_1")).toBeUndefined();

  await store.activate("ses_1", path);
  expect((await store.active("ses_1"))?.progress).toEqual({ open: 2, done: 0 });
  writeFileSync(path, "- [x] a\n- [ ] b");
  expect((await store.active("ses_1"))?.progress).toEqual({ open: 1, done: 1 });

  expect((await createPlanStore(storage).active("ses_1"))?.path).toBe(path);
  expect(await store.active("ses_2")).toBeUndefined();

  rmSync(path);
  expect(await store.active("ses_1")).toBeUndefined();
  expect(storage.data.size).toBe(0);

  await store.activate("ses_1", path);
  expect(await store.clear("ses_1")).toBe(path);
  expect(await store.clear("ses_1")).toBeUndefined();
});

test("renderActivePlan states progress and truncates a very long plan", () => {
  const text = renderActivePlan({ path: "/r/.foreman/plans/p.md", content: "- [ ] a", progress: { open: 1, done: 2 } });
  expect(text).toContain("1 of 3 tasks are still open");
  expect(text).toContain("<plan>\n- [ ] a\n</plan>");
  const long = renderActivePlan({ path: "/p.md", content: "x".repeat(20_000), progress: { open: 0, done: 0 } });
  expect(long.length).toBeLessThan(13_000);
  expect(long).toContain("truncated");
});

test("runChecks stops at the first failure and reports its command, status, and output", async () => {
  const seen: string[] = [];
  const started: string[] = [];
  const result = await runChecks(["lint", "test", "build"], "/repo", 1_000, {
    runner: async (command, cwd) => {
      seen.push(`${cwd}:${command}`);
      return command === "test" ? { status: 2, output: "boom" } : { status: 0, output: "" };
    },
    onStart: (progress) => void started.push(`${progress.index + 1}/${progress.total} ${progress.command}`),
  });
  expect(started).toEqual(["1/3 lint", "2/3 test"]);
  expect(seen).toEqual(["/repo:lint", "/repo:test"]);
  expect(result).toEqual({ passed: ["lint"], failure: { command: "test", status: 2, output: "boom" }, cancelled: false });
});

test("the shell runner captures output and exit codes, runs in the directory, and enforces the timeout", async () => {
  writeFileSync(join(root, "marker.txt"), "here");
  expect(await runChecks(["cat marker.txt"], root, 5_000)).toEqual({ passed: ["cat marker.txt"], failure: undefined, cancelled: false });
  const failed = await runChecks(["echo out; echo err >&2; exit 3"], root, 5_000);
  expect(failed.failure?.status).toBe(3);
  expect(failed.failure?.output ?? "").toContain("out");
  expect(failed.failure?.output ?? "").toContain("err");
  expect((await runChecks(["sleep 5"], root, 200)).failure?.status).toBe("timeout");
});

test("two plan stores over the same storage always agree", async () => {
  const storage = memoryStorage();
  const here = createPlanStore(storage);
  const there = createPlanStore(storage);
  const path = join(plans, "auth.md");
  writeFileSync(path, "- [ ] a");
  expect(await here.active("ses_1")).toBeUndefined();
  await there.activate("ses_1", path);
  expect((await here.active("ses_1"))?.path).toBe(path);
  await here.clear("ses_1");
  expect(await there.active("ses_1")).toBeUndefined();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a timeout kills the processes the check started, not only its shell", async () => {
  const pidFile = join(root, "child.pid");
  const result = await runChecks([`sleep 30 & echo $! > ${pidFile}; wait`], root, 300);
  expect(result.failure?.status).toBe("timeout");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await wait(200);
  expect(alive(pid)).toBe(false);
});

test("cancelling stops a running check, kills what it started, and runs nothing after it", async () => {
  const pidFile = join(root, "child.pid");
  const controller = new AbortController();
  const run = runChecks([`sleep 30 & echo $! > ${pidFile}; wait`, "touch never.txt"], root, 30_000, { signal: controller.signal });
  for (let waited = 0; waited < 3_000 && !existsSync(pidFile); waited += 25) await wait(25);
  await wait(50);
  controller.abort();
  expect(await run).toEqual({ passed: [], failure: undefined, cancelled: true });
  await wait(200);
  expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  expect(existsSync(join(root, "never.txt"))).toBe(false);

  expect(await runChecks(["touch never.txt"], root, 5_000, { signal: controller.signal })).toMatchObject({ cancelled: true });
});
