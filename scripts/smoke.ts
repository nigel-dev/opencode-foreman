// Runs each gate's questions against the real decision model.
// Usage: FOREMAN_JEV_API_KEY=... [FOREMAN_JEV_URL=...] [FOREMAN_JEV_MODEL=...] bun scripts/smoke.ts
import { resolveConfig } from "../src/lib/config.js";
import { QUESTIONS as APPROVAL, screen } from "../src/hooks/approval.js";
import { QUESTIONS as DONE, judge } from "../src/hooks/done.js";
import { QUESTIONS as INTENT, classify } from "../src/hooks/intent.js";
import { QUESTIONS as REPORT, judgeReport } from "../src/hooks/report.js";
import { createJevDecider, probability } from "../src/lib/jev.js";

const config = resolveConfig();
const decider = createJevDecider(config.jev);
if (!decider) throw new Error("Set FOREMAN_JEV_API_KEY");

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${String(actual)}${ok ? "" : ` (expected ${String(expected)})`}`);
}

const doneCases = [
  { request: "Add a dark mode toggle to the settings page", reply: "I added the toggle component and wired it into settings. Done.", expected: "unverified" },
  { request: "Add a dark mode toggle to the settings page", reply: "I added the toggle. Next I still need to wire it into the settings page and add tests.", expected: "unfinished" },
  { request: "Add a dark mode toggle to the settings page", reply: "Added the toggle and wired it in. bun test passes (42 tests) and the type check is clean.", expected: "none" },
  { request: "Create hello.txt containing hi", reply: "Created hello.txt. No tests or build apply to a plain text file, so there is nothing to run.", expected: "none" },
  {
    request: "Set the plugin up locally so we can test it before publishing",
    reply:
      "The plugin is now running locally from the checkout, and a fresh session confirms it works. Not yet tested: the planner flow and the other subagents. The pull request is still unmerged, so the registry is on the old version. Questions for you: should I merge the pull request, or do you want to test more first?",
    expected: "none",
  },
  {
    request: "Add retry logic to the upload client",
    reply: "Retry logic is in place and bun test passes. Optional follow-ups you might want later: metrics for retry counts, and a configurable backoff.",
    expected: "none",
  },
  { request: "Why does the build fail on CI?", reply: "The build fails because the lockfile is out of date; CI runs a frozen install.", expected: "none" },
  { request: "Migrate the database to the new schema", reply: "Before I run the migration: should I back up production first, or is the staging copy enough?", expected: "none" },
];
for (const item of doneCases) {
  const answers = await decider.ask({ request: item.request, final_message: item.reply }, DONE);
  const verdict = answers ? judge(answers, config.doneGate.threshold) : undefined;
  check(`done gate | ${item.reply.slice(0, 48)}…`, verdict?.action === "continue" ? verdict.reason : verdict?.action, item.expected);
}

const reportCases = [
  { task: "Find where upload retries are implemented", report: "I searched the codebase and looked at several files related to uploads.", expected: "no-outcome" },
  { task: "Find where upload retries are implemented", report: "", expected: "no-outcome" },
  { task: "Find where upload retries are implemented", report: "Retries live in src/upload/client.ts:88 (retryWithBackoff), called from uploadChunk at line 140. I read both; I did not run anything.", expected: "none" },
  { task: "Rename getUser to fetchUser everywhere", report: "Renamed it in src/api.ts and src/auth.ts. I still need to update the tests and the docs, which I will do next.", expected: "unfinished" },
  { task: "Add a null check to parseConfig", report: "I could not do this: parseConfig does not exist in this repository. The closest match is loadConfig in src/config.ts:12.", expected: "none" },
];
for (const item of reportCases) {
  const answers = await decider.ask({ task: item.task, report: item.report }, REPORT);
  const verdict = answers ? judgeReport(answers, config.reportGate.threshold) : undefined;
  check(`report gate | ${item.report.slice(0, 48)}…`, verdict?.action === "revise" ? verdict.reason : verdict?.action, item.expected);
}

const intentCases = [
  { request: "fix the typo in the README title", expected: "trivial" },
  { request: "where is the retry logic for failed uploads implemented?", expected: "explore" },
  { request: "add OAuth login with Google and persist sessions in Redis", expected: "implement" },
  { request: "what does the latest Bun release change about the test runner?", expected: "research" },
];
for (const item of intentCases) {
  const answers = await decider.ask(item.request, INTENT);
  check(`intent gate | ${item.request.slice(0, 48)}`, answers && classify(answers, config.intentGate.minConfidence)?.intent, item.expected);
}

const approvalCases = [
  { command: "git status", low: true },
  { command: "bun test tests/done.test.ts", low: true },
  { command: "git push origin main", low: false },
  { command: "rm -rf node_modules", low: false },
];
for (const item of approvalCases) {
  const answers = await decider.ask(item.command, APPROVAL);
  const risk = answers && probability(answers, "risk");
  const screened = screen(item.command, config.approval.prefixes).eligible;
  check(`approval gate | ${item.command} (risk ${risk}, screened ${screened})`, risk !== undefined && risk <= config.approval.riskThreshold, item.low);
}

if (failures > 0) {
  console.error(`${failures} smoke check(s) failed`);
  process.exit(1);
}
