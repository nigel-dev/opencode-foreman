import { expect, test } from "bun:test";
import { parseDecision, parseStatus, type Decision, type Status } from "../../src/rpc.js";
import { decisionToast, describeDecision, desiredVariant, planSummary, progressBar, statusReport } from "../../src/tui/format.js";

const decision = (fields: Partial<Decision>): Decision => ({ time: 0, sessionID: "ses_1", gate: "done", action: "none", reason: "done", ...fields });

const status = (fields: Partial<Status> = {}): Status => ({
  plan: null,
  decisions: [],
  gates: { done: true, report: true, intent: true, approval: false, loop: true },
  decisionModel: true,
  configFiles: [],
  logFile: null,
  syncVariants: true,
  ...fields,
});

test("parseDecision and parseStatus accept what the server sends and reject malformed values", () => {
  const wire = JSON.parse(JSON.stringify(status({ plan: { name: "auth", path: "/p/auth.md", open: 2, done: 1 }, decisions: [decision({ detail: "bun test" })] })));
  expect(parseStatus(wire)).toEqual(status({ plan: { name: "auth", path: "/p/auth.md", open: 2, done: 1 }, decisions: [decision({ detail: "bun test" })] }));
  expect(parseStatus({ decisions: [{ gate: "bogus" }, decision({})], gates: {} })?.decisions).toHaveLength(1);
  expect(parseStatus({ gates: {} })).toBeUndefined();
  expect(parseDecision({ ...decision({}), gate: "nope" })).toBeUndefined();
  expect(parseDecision("x")).toBeUndefined();
});

test("only decisions where Foreman stepped in produce a toast", () => {
  expect(decisionToast(decision({}))).toBeUndefined();
  expect(decisionToast(decision({ gate: "intent", action: "hint", reason: "implement, moderate" }))).toBeUndefined();
  expect(decisionToast(decision({ gate: "approval", action: "would-approve", reason: "risk 0.03", detail: "git status" }))).toBeUndefined();
  expect(decisionToast(decision({ action: "continue", reason: "checks-failed", detail: "bun test" }))).toEqual({
    title: "Foreman: done gate",
    message: "A project check failed, so the agent was sent the output (bun test)",
    variant: "warning",
  });
  expect(decisionToast(decision({ gate: "loop", action: "blocked", reason: "repeated call", detail: "read" }))?.message).toBe("Blocked a repeated call (read)");
  expect(decisionToast(decision({ gate: "report", action: "revise", reason: "no-outcome" }))?.variant).toBe("info");
  expect(decisionToast(decision({ gate: "approval", action: "approved", reason: "risk 0.03", detail: "git status" }))?.variant).toBe("success");
});

test("describeDecision covers every gate", () => {
  expect(describeDecision(decision({ reason: "waiting on the user" }))).toBe("left alone: waiting on the user");
  expect(describeDecision(decision({ gate: "intent", action: "hint", reason: "plan, large" }))).toBe("routed as plan, large");
  expect(describeDecision(decision({ gate: "approval", action: "kept", reason: "risk 0.6", detail: "git push" }))).toBe("kept the prompt for `git push`, risk 0.6");
  expect(describeDecision(decision({ gate: "report", action: "none", reason: "usable report" }))).toBe("left alone: usable report");
});

test("plan summary and progress bar reflect checkbox progress", () => {
  const withPlan = status({ plan: { name: "auth", path: "/p", open: 3, done: 7 } });
  expect(planSummary(withPlan)).toBe("auth 7/10");
  expect(progressBar(withPlan)).toBe("███████░░░");
  expect(planSummary(status({ plan: { name: "loose", path: "/p", open: 0, done: 0 } }))).toBe("loose");
  expect(progressBar(status({ plan: { name: "loose", path: "/p", open: 0, done: 0 } }))).toBe("");
  expect(planSummary(status())).toBeUndefined();
  expect(planSummary(undefined)).toBeUndefined();
});

test("statusReport lists the plan, gates, decisions, config, and log", () => {
  const report = statusReport(
    status({
      plan: { name: "auth", path: "/home/me/r/.foreman/plans/auth.md", open: 1, done: 2 },
      decisions: [decision({ action: "continue", reason: "plan-open" })],
      configFiles: ["/home/me/.config/opencode/foreman.jsonc"],
      logFile: "/home/me/.local/share/opencode/foreman/decisions.jsonl",
    }),
    (path) => path.replace("/home/me", "~"),
  );
  expect(report).toContain("Plan: auth, 2 of 3 tasks done");
  expect(report).toContain("~/r/.foreman/plans/auth.md");
  expect(report).toContain("On: Done gate, Report gate, Intent gate, Loop guard");
  expect(report).toContain("Off: Approval gate");
  expect(report).toContain("Done gate: the plan still has open tasks");
  expect(report).toContain("Config: ~/.config/opencode/foreman.jsonc");
  expect(report).toContain("Log: ~/.local/share/opencode/foreman/decisions.jsonl");

  const empty = statusReport(status({ decisionModel: false }));
  expect(empty).toContain("Plan: none active");
  expect(empty).toContain("No decisions recorded");
  expect(empty).toContain("only the loop guard can run");
  expect(empty).toContain("defaults (no foreman.json found)");
});

test("desiredVariant uses the session's agent, else the variant the primary agents agree on", () => {
  const opus = { providerID: "anthropic", id: "claude-opus-5-5" };
  const fable = { providerID: "anthropic", id: "claude-fable-5-2" };
  const agents = [
    { id: "orchestrator", mode: "primary", model: { ...opus, variant: "high" } },
    { id: "planner", mode: "primary", model: { ...fable, variant: "high" } },
    { id: "worker-visual", mode: "subagent", model: { ...fable, variant: "max" } },
    { id: "build", mode: "primary" },
  ];
  const model = (ref: { providerID: string; id: string }) => ({ providerID: ref.providerID, modelID: ref.id });
  expect(desiredVariant(agents, model(opus))).toBe("high");
  expect(desiredVariant(agents, model(fable))).toBe("high");
  expect(desiredVariant(agents, model(fable), "worker-visual")).toBe("max");
  expect(desiredVariant(agents, model(fable), "build")).toBe("high");
  expect(desiredVariant(agents, { providerID: "openai", modelID: "gpt-6-astra" })).toBeUndefined();
  const split = [...agents, { id: "custom", mode: "all", model: { ...opus, variant: "low" } }];
  expect(desiredVariant(split, model(opus))).toBeUndefined();
  expect(desiredVariant(split, model(opus), "custom")).toBe("low");
  expect(desiredVariant([{ id: "hidden", mode: "primary", hidden: true, model: { ...opus, variant: "max" } }], model(opus))).toBeUndefined();
});
