import { Rpc } from "@opencode/plugin/rpc";

// Contract shared by the server part and the TUI part. It may only import `@opencode/plugin/rpc`.

export const GATES = ["done", "report", "intent", "approval", "loop"] as const;
export type Gate = (typeof GATES)[number];

/** One thing a gate or guard decided. Carries no prompt or message text. */
export interface Decision {
  readonly time: number;
  readonly sessionID: string;
  readonly gate: Gate;
  /** What the gate did: `none` when it left the session alone. */
  readonly action: string;
  readonly reason: string;
  /** Short context such as the failed check command or the blocked tool. */
  readonly detail?: string;
}

export interface PlanStatus {
  readonly name: string;
  readonly path: string;
  readonly open: number;
  readonly done: number;
}

/** Whether the decision model answered the last time a gate asked it. */
export interface Health {
  /** `off` when no key is configured, `unknown` until the first call. */
  readonly state: "ok" | "failing" | "unknown" | "off";
  /** Why the last call failed, such as `HTTP 401` or `timed out`. */
  readonly detail?: string;
  readonly time?: number;
}

/** A project check the done gate is running right now. */
export interface RunningCheck {
  readonly command: string;
  readonly index: number;
  readonly total: number;
  readonly startedAt: number;
}

export interface Status {
  readonly plan: PlanStatus | null;
  /** Most recent first. */
  readonly decisions: readonly Decision[];
  readonly gates: Readonly<Record<Gate, boolean>>;
  /** Whether a decision-model key is configured; without one only the loop guard runs. */
  readonly decisionModel: boolean;
  readonly configFiles: readonly string[];
  readonly logFile: string | null;
  readonly syncVariants: boolean;
  readonly health: Health;
  /** Supervision is paused for this session. */
  readonly paused: boolean;
  readonly check: RunningCheck | null;
}

const decision = {
  type: "object",
  properties: {
    time: { type: "number" },
    sessionID: { type: "string" },
    gate: { type: "string", enum: [...GATES] },
    action: { type: "string" },
    reason: { type: "string" },
    detail: { type: "string" },
  },
  required: ["time", "sessionID", "gate", "action", "reason"],
  additionalProperties: false,
} as const;

export const foremanRpc = Rpc.define({
  id: "foreman",
  methods: {
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        additionalProperties: false,
      },
      output: { type: "object" },
    },
    /** Stops the project check running for a session, if any. */
    cancelCheck: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "object" },
    },
  },
  events: {
    decision: { schema: decision },
    plan: {
      schema: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
    },
    /** A session's check started or stopped, or its pause state changed; the TUI re-reads its status. */
    session: {
      schema: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
    },
    health: {
      schema: {
        type: "object",
        properties: { state: { type: "string" }, detail: { type: "string" } },
        required: ["state"],
        additionalProperties: false,
      },
    },
    config: {
      schema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          /** False when a file could not be read and the previous settings were kept. */
          applied: { type: "boolean" },
        },
        required: ["files", "warnings", "applied"],
        additionalProperties: false,
      },
    },
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDecision(value: unknown): Decision | undefined {
  if (!isRecord(value)) return undefined;
  const { time, sessionID, gate, action, reason, detail } = value;
  if (typeof time !== "number" || !Number.isFinite(time) || typeof sessionID !== "string" || typeof action !== "string" || typeof reason !== "string") return undefined;
  if (!(GATES as readonly unknown[]).includes(gate)) return undefined;
  return { time, sessionID, gate: gate as Gate, action, reason, ...(typeof detail === "string" ? { detail } : {}) };
}

const HEALTH_STATES = ["ok", "failing", "unknown", "off"] as const;

export function parseHealth(value: unknown): Health {
  if (!isRecord(value) || !(HEALTH_STATES as readonly unknown[]).includes(value.state)) return { state: "unknown" };
  return {
    state: value.state as Health["state"],
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    ...(typeof value.time === "number" ? { time: value.time } : {}),
  };
}

function parseCheck(value: unknown): RunningCheck | null {
  if (!isRecord(value)) return null;
  const { command, index, total, startedAt } = value;
  if (typeof command !== "string" || typeof index !== "number" || typeof total !== "number" || typeof startedAt !== "number") return null;
  return { command, index, total, startedAt };
}

/** JSON Schema values arrive untyped, so the TUI narrows the status before rendering it. */
export function parseStatus(value: unknown): Status | undefined {
  if (!isRecord(value) || !Array.isArray(value.decisions) || !isRecord(value.gates)) return undefined;
  const plan = value.plan;
  const parsedPlan =
    isRecord(plan) && typeof plan.name === "string" && typeof plan.path === "string" && typeof plan.open === "number" && typeof plan.done === "number"
      ? { name: plan.name, path: plan.path, open: plan.open, done: plan.done }
      : null;
  const gates = Object.fromEntries(GATES.map((gate) => [gate, (value.gates as Record<string, unknown>)[gate] === true])) as Record<Gate, boolean>;
  return {
    plan: parsedPlan,
    decisions: value.decisions.flatMap((item) => parseDecision(item) ?? []),
    gates,
    decisionModel: value.decisionModel === true,
    configFiles: Array.isArray(value.configFiles) ? value.configFiles.filter((file): file is string => typeof file === "string") : [],
    logFile: typeof value.logFile === "string" ? value.logFile : null,
    syncVariants: value.syncVariants !== false,
    health: parseHealth(value.health),
    paused: value.paused === true,
    check: parseCheck(value.check),
  };
}
