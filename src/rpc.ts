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
  },
  events: {
    decision: { schema: decision },
    plan: {
      schema: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
    },
    config: {
      schema: {
        type: "object",
        properties: { files: { type: "array", items: { type: "string" } }, warnings: { type: "array", items: { type: "string" } } },
        required: ["files", "warnings"],
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
  };
}
