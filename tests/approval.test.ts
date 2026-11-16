import { expect, test } from "bun:test";
import { DEFAULT_PREFIXES, resolveConfig } from "../src/config.js";
import { createApprovalGate, screen, type ApprovalRecord, type EvaluateEvent } from "../src/gates/approval.js";
import { fakeDecider, noul } from "./helpers.js";

test("screen accepts plain eligible commands", () => {
  for (const command of ["git status", "git diff --stat", "bun test tests/a.test.ts", "ls -la src"]) {
    expect(screen(command, DEFAULT_PREFIXES)).toEqual({ eligible: true });
  }
});

test("screen rejects chaining, redirection, substitution, secrets, risky flags, and other commands", () => {
  const rejected: Array<[string, string]> = [
    ["git status; rm -rf .", "shell syntax"],
    ["git status && curl x", "shell syntax"],
    ["git log | sh", "shell syntax"],
    ["git diff > out.patch", "shell syntax"],
    ["ls $(whoami)", "shell syntax"],
    ["ls `whoami`", "shell syntax"],
    ["git show HEAD:.env", "secret-like path"],
    ["ls ~/.ssh", "secret-like path"],
    ["rg api_token src", "secret-like path"],
    ["git diff --output=/tmp/x", "risky flag"],
    ["rm -rf build", "not an eligible prefix"],
    ["git statusx", "not an eligible prefix"],
    ["", "empty command"],
  ];
  for (const [command, reason] of rejected) {
    expect(screen(command, DEFAULT_PREFIXES)).toEqual({ eligible: false, reason });
  }
});

function harness(risk: number | undefined, options: Record<string, unknown> = {}, auditFails = false) {
  const records: ApprovalRecord[] = [];
  const decider = fakeDecider(risk === undefined ? undefined : { risk: noul(risk) });
  const gate = createApprovalGate({
    config: resolveConfig({ approval: { enabled: true, ...options } }).approval,
    decider,
    audit: async (record) => {
      if (auditFails) throw new Error("storage down");
      records.push(record);
    },
    now: () => 1_000,
  });
  return { gate, decider, records };
}

function ask(command = "git status", overrides: Partial<EvaluateEvent> = {}): EvaluateEvent {
  return { sessionID: "ses_1", action: "shell", resources: [command], effect: "ask", ...overrides };
}

test("dry run records a low-risk command but leaves the prompt in place", async () => {
  const { gate, records } = harness(0.02);
  const event = ask();
  expect(await gate(event)).toEqual({ action: "would-approve", risk: 0.02 });
  expect(event.effect).toBe("ask");
  expect(records).toEqual([{ time: 1_000, sessionID: "ses_1", command: "git status", risk: 0.02, approved: true, dryRun: true }]);
});

test("with dry run off a low-risk command is allowed and a risky one is kept", async () => {
  const low = harness(0.02, { dryRun: false });
  const allowed = ask();
  expect(await low.gate(allowed)).toEqual({ action: "approved", risk: 0.02 });
  expect(allowed.effect).toBe("allow");

  const high = harness(0.6, { dryRun: false });
  const kept = ask();
  expect(await high.gate(kept)).toEqual({ action: "kept", risk: 0.6 });
  expect(kept.effect).toBe("ask");
  expect(high.records[0]?.approved).toBe(false);
});

test("never approves when the decision or the audit record is missing", async () => {
  for (const h of [harness(undefined, { dryRun: false }), harness(0.01, { dryRun: false }, true)]) {
    const event = ask();
    expect((await h.gate(event)).action).toBe("skipped");
    expect(event.effect).toBe("ask");
  }
});

test("ignores anything that is not a single eligible shell ask, without calling the model", async () => {
  const events = [
    ask("git status", { effect: "allow" }),
    ask("git status", { action: "edit" }),
    ask("git status", { resources: ["git status", "ls"] }),
    ask("rm -rf /"),
  ];
  for (const event of events) {
    const h = harness(0.01, { dryRun: false });
    const before = event.effect;
    expect((await h.gate(event)).action).toBe("skipped");
    expect(event.effect).toBe(before);
    expect(h.decider.calls).toHaveLength(0);
  }
});
