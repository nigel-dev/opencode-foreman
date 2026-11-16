import type { Decision, Gate, Health, Status } from "../rpc.js";

export type Tone = "info" | "success" | "warning" | "error";

const GATE_LABEL: Readonly<Record<Gate, string>> = {
  done: "Done gate",
  report: "Report gate",
  intent: "Intent gate",
  approval: "Approval gate",
  loop: "Loop guard",
};

const DONE_REASON: Readonly<Record<string, string>> = {
  unfinished: "work remained, so the agent was told to continue",
  unverified: "completion was claimed without a check, so the agent was told to verify",
  "checks-failed": "a project check failed, so the agent was sent the output",
  "plan-open": "the plan still has open tasks, so the agent was told to continue",
};

const REPORT_REASON: Readonly<Record<string, string>> = {
  unfinished: "a subagent stopped partway and was told to finish",
  "no-outcome": "a subagent report gave no outcome and was sent back",
};

const EXHAUSTED_REASON: Readonly<Record<string, string>> = {
  unfinished: "work still remains",
  unverified: "completion is still unverified",
  "checks-failed": "a project check still fails",
  "plan-open": "the plan still has open tasks",
};

export function gateLabel(gate: Gate): string {
  return GATE_LABEL[gate];
}

/** One line saying what a gate did, for the sidebar and the status dialog. */
export function describeDecision(decision: Decision): string {
  const detail = decision.detail ? ` (${decision.detail})` : "";
  switch (decision.gate) {
    case "done":
      if (decision.action === "continue") return `${DONE_REASON[decision.reason] ?? decision.reason}${detail}`;
      if (decision.action === "exhausted") return `${EXHAUSTED_REASON[decision.reason] ?? decision.reason}${detail}, and the continuation limit is used up`;
      if (decision.action === "paused") return "supervision paused for this session";
      if (decision.action === "resumed") return "supervision resumed for this session";
      return `left alone: ${decision.reason}`;
    case "report":
      return decision.action === "revise" ? (REPORT_REASON[decision.reason] ?? decision.reason) : `left alone: ${decision.reason}`;
    case "intent":
      return decision.action === "hint" ? `routed as ${decision.reason}` : `no hint: ${decision.reason}`;
    case "approval":
      return `${decision.action === "approved" ? "approved" : decision.action === "would-approve" ? "would approve (dry run)" : "kept the prompt for"} \`${decision.detail ?? "command"}\`, ${decision.reason}`;
    case "loop":
      return `blocked a ${decision.reason}${detail}`;
  }
}

export interface ToastText {
  readonly title: string;
  readonly message: string;
  readonly variant: Tone;
}

/** Only decisions where Foreman stepped in get a toast; routine "left alone" verdicts and routing hints do not. */
export function decisionToast(decision: Decision): ToastText | undefined {
  if (decision.gate === "done" && (decision.action === "paused" || decision.action === "resumed")) {
    return { title: "Foreman", message: decision.action === "paused" ? "Supervision paused for this session." : "Supervision resumed for this session.", variant: "info" };
  }
  const acted =
    (decision.gate === "done" && (decision.action === "continue" || decision.action === "exhausted")) ||
    (decision.gate === "report" && decision.action === "revise") ||
    (decision.gate === "loop" && decision.action === "blocked") ||
    (decision.gate === "approval" && decision.action === "approved");
  if (!acted) return undefined;
  const message = describeDecision(decision);
  return {
    title: `Foreman: ${gateLabel(decision.gate).toLowerCase()}`,
    message: message.charAt(0).toUpperCase() + message.slice(1),
    variant:
      decision.gate === "approval"
        ? "success"
        : decision.action === "exhausted" || decision.reason === "checks-failed" || decision.gate === "loop"
          ? "warning"
          : "info",
  };
}

export function planSummary(status: Status | undefined): string | undefined {
  const plan = status?.plan;
  if (!plan) return undefined;
  const total = plan.open + plan.done;
  return total > 0 ? `${plan.name} ${plan.done}/${total}` : plan.name;
}

/** A ten-cell bar such as `███████░░░`; empty for a plan with no checkboxes. */
export function progressBar(status: Status | undefined, width = 10): string {
  const plan = status?.plan;
  const total = plan ? plan.open + plan.done : 0;
  if (!plan || total === 0) return "";
  const filled = Math.round((plan.done / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Whether the gates can actually reach the decision model, as opposed to merely being switched on. */
export function healthText(health: Health): string {
  switch (health.state) {
    case "ok":
      return `working${health.time ? ` (last answer ${clock(health.time)})` : ""}`;
    case "failing":
      return `not answering: ${health.detail ?? "unknown error"}${health.time ? ` at ${clock(health.time)}` : ""}. The gates that use it are doing nothing.`;
    case "off":
      return "no key is set, so only the loop guard, commands, and plan tracking run";
    case "unknown":
      return "not used yet since the plugin loaded";
  }
}

/** Footer text for a running check, such as `checking bun test 12s`. */
export function checkText(status: Status | undefined, now: number): string | undefined {
  const check = status?.check;
  if (!check) return undefined;
  const seconds = Math.max(0, Math.round((now - check.startedAt) / 1000));
  const position = check.total > 1 ? ` ${check.index + 1}/${check.total}` : "";
  return `checking${position} ${check.command} ${seconds}s`;
}

function clock(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The body of the `/foreman` dialog. */
export function statusReport(status: Status, home: (path: string) => string = (path) => path): string {
  const lines: string[] = [];
  const plan = status.plan;
  if (plan) {
    const total = plan.open + plan.done;
    lines.push(`Plan: ${plan.name}, ${plan.done} of ${total} tasks done`, `  ${home(plan.path)}`);
  } else {
    lines.push("Plan: none active in this session");
  }
  lines.push("");
  const on = (Object.keys(GATE_LABEL) as Gate[]).filter((gate) => status.gates[gate]).map(gateLabel);
  const off = (Object.keys(GATE_LABEL) as Gate[]).filter((gate) => !status.gates[gate]).map(gateLabel);
  lines.push(`On: ${on.length > 0 ? on.join(", ") : "nothing"}`);
  if (off.length > 0) lines.push(`Off: ${off.join(", ")}`);
  lines.push(`Decision model: ${healthText(status.health)}`);
  if (status.paused) lines.push("Supervision is paused for this session. Run /foreman-resume to turn it back on.");
  if (status.check) lines.push(`Running check ${status.check.index + 1} of ${status.check.total}: ${status.check.command}`);
  lines.push("");
  if (status.decisions.length === 0) {
    lines.push("No decisions recorded for this session yet.");
  } else {
    lines.push("Recent decisions:");
    for (const decision of status.decisions.slice(0, 10)) lines.push(`  ${clock(decision.time)}  ${gateLabel(decision.gate)}: ${describeDecision(decision)}`);
  }
  lines.push("");
  lines.push(`Config: ${status.configFiles.length > 0 ? status.configFiles.map(home).join(", ") : "defaults (no foreman.json found)"}`);
  if (status.logFile) lines.push(`Log: ${home(status.logFile)}`);
  return lines.join("\n");
}

export interface AgentModel {
  readonly id: string;
  readonly mode: string;
  readonly hidden?: boolean | undefined;
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string | undefined } | undefined;
}

/**
 * The variant the prompt should use for a model, taken from the agents configured with that model.
 * The session's own agent decides when it uses the model; otherwise the primary agents must agree,
 * because the TUI does not say which agent is selected before a session exists.
 */
export function desiredVariant(
  agents: readonly AgentModel[],
  model: { readonly providerID: string; readonly modelID: string },
  sessionAgent?: string,
): string | undefined {
  const matches = agents.filter(
    (agent) => agent.model?.variant !== undefined && agent.model.providerID === model.providerID && agent.model.id === model.modelID,
  );
  const own = matches.find((agent) => agent.id === sessionAgent);
  if (own) return own.model?.variant;
  const variants = new Set(matches.filter((agent) => agent.mode !== "subagent" && !agent.hidden).map((agent) => agent.model?.variant));
  return variants.size === 1 ? [...variants][0] : undefined;
}
