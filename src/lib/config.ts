import { ROSTER_ROUTES, TIERS, type Tier } from "../agents/index.js";
import { defaultLogPath, type LogConfig } from "./log.js";
import { parseModel, type ModelRef } from "./models.js";

export const INTENTS = ["trivial", "explore", "implement", "plan", "research", "discuss"] as const;
export type Intent = (typeof INTENTS)[number];

export interface JevConfig {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface DoneGateConfig {
  readonly enabled: boolean;
  readonly maxContinuations: number;
  readonly threshold: number;
  /** Commands run in the session's directory when the assistant claims completion; the first failure is sent back. */
  readonly checks: readonly string[];
  readonly checkTimeoutMs: number;
}

export interface ReportGateConfig {
  readonly enabled: boolean;
  readonly threshold: number;
}

export interface LoopGuardConfig {
  readonly enabled: boolean;
  /** Identical consecutive calls allowed before the next one is blocked. */
  readonly maxRepeats: number;
  /** Tool names the guard never counts. */
  readonly ignore: readonly string[];
}

export interface PlansConfig {
  /** Inject the session's active plan into each model request and hold the session to its open tasks. */
  readonly enabled: boolean;
}

export interface IntentGateConfig {
  readonly enabled: boolean;
  readonly minConfidence: number;
  readonly routes: Readonly<Record<Intent, string>>;
}

export interface ApprovalConfig {
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly riskThreshold: number;
  readonly prefixes: readonly string[];
}

export interface AgentOverride {
  readonly model?: ModelRef;
  readonly disabled?: boolean;
}

export interface AgentsConfig {
  /** Register the agents that ship with the plugin. */
  readonly bundled: boolean;
  /** Agent to select for new sessions. Left to OpenCode when unset. */
  readonly defaultAgent: string | undefined;
  /** Model per tier; every agent in the tier uses it unless overridden. */
  readonly tiers: Readonly<Partial<Record<Tier, ModelRef>>>;
  /** Per-agent settings, keyed by agent ID. Applies to any agent, bundled or not. */
  readonly overrides: Readonly<Record<string, AgentOverride>>;
}

export interface ForemanConfig {
  readonly agents: AgentsConfig;
  readonly jev: JevConfig;
  readonly doneGate: DoneGateConfig;
  readonly reportGate: ReportGateConfig;
  readonly loopGuard: LoopGuardConfig;
  readonly plans: PlansConfig;
  readonly commands: boolean;
  /** Let the TUI part set the prompt's variant to the selected agent's configured one when the model changes. */
  readonly syncVariants: boolean;
  readonly log: LogConfig;
  readonly intentGate: IntentGateConfig;
  readonly approval: ApprovalConfig;
}

export const DEFAULT_ROUTES: Readonly<Record<Intent, string>> = {
  trivial: "Handle it directly. Do not delegate or plan.",
  explore: "Gather the answer with a search subagent, then report. Do not edit files.",
  implement: "Delegate implementation to a worker sized to the complexity, then verify the result yourself.",
  plan: "Produce or refine a plan before any edits, and confirm it with the user.",
  research: "Use a research subagent for external sources, then summarise with citations. Do not edit files.",
  discuss: "Answer directly. Do not edit files or delegate.",
};

export const DEFAULT_PREFIXES: readonly string[] = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "ls",
  "pwd",
  "rg",
  "grep",
  "bun test",
  "bun run test",
  "bun run lint",
  "bun run typecheck",
  "bun run build",
  "tsc --noEmit",
  "cargo check",
  "cargo test",
  "go build",
  "go test",
  "pytest",
  "uv run pytest",
];

type Source = Readonly<Record<string, unknown>>;

function section(value: unknown): Source {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Source) : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function list(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function resolveAgents(options: Source, warnings: string[]): AgentsConfig {
  const tiers: Partial<Record<Tier, ModelRef>> = {};
  for (const [tier, value] of Object.entries(section(options.models))) {
    const model = parseModel(value);
    if (!(TIERS as readonly string[]).includes(tier)) warnings.push(`models.${tier} is not a tier (${TIERS.join(", ")}); ignored.`);
    else if (!model) warnings.push(`models.${tier} must look like "provider/model" or "provider/model#variant"; ignored.`);
    else tiers[tier as Tier] = model;
  }

  const overrides: Record<string, AgentOverride> = {};
  for (const [id, value] of Object.entries(section(options.agents))) {
    const entry = section(value);
    const model = entry.model === undefined ? undefined : parseModel(entry.model);
    if (entry.model !== undefined && !model) {
      warnings.push(`agents.${id}.model must look like "provider/model" or "provider/model#variant"; ignored.`);
    }
    overrides[id] = {
      ...(model ? { model } : {}),
      ...(typeof entry.disabled === "boolean" ? { disabled: entry.disabled } : {}),
    };
  }

  const defaultAgent = text(options.defaultAgent, "");
  return {
    bundled: flag(options.bundledAgents, true),
    defaultAgent: defaultAgent === "" ? undefined : defaultAgent,
    tiers,
    overrides,
  };
}

export function resolveConfig(
  options: Source = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
  warnings: string[] = [],
): ForemanConfig {
  const jev = section(options.jev);
  const doneGate = section(options.doneGate);
  const intentGate = section(options.intentGate);
  const reportGate = section(options.reportGate);
  const loopGuard = section(options.loopGuard);
  const plans = section(options.plans);
  const log = section(options.log);
  const approval = section(options.approval);
  const routes = section(intentGate.routes);
  const apiKey = text(jev.apiKey, text(env.FOREMAN_JEV_API_KEY, ""));
  const agents = resolveAgents(options, warnings);
  const defaultRoutes = agents.bundled ? ROSTER_ROUTES : DEFAULT_ROUTES;

  return {
    agents,
    jev: {
      url: text(jev.url, text(env.FOREMAN_JEV_URL, "https://api.typesafe.ai/v1/systemone")),
      apiKey: apiKey === "" ? undefined : apiKey,
      model: text(jev.model, text(env.FOREMAN_JEV_MODEL, "jev-latest")),
      timeoutMs: bounded(jev.timeoutMs, 3_000, 100, 60_000),
    },
    doneGate: {
      enabled: flag(doneGate.enabled, true),
      maxContinuations: Math.floor(bounded(doneGate.maxContinuations, 2, 0, 10)),
      threshold: bounded(doneGate.threshold, 0.5, 0, 1),
      checks: list(doneGate.checks, []),
      checkTimeoutMs: bounded(doneGate.checkTimeoutMs, 120_000, 1_000, 900_000),
    },
    reportGate: {
      enabled: flag(reportGate.enabled, true),
      threshold: bounded(reportGate.threshold, 0.5, 0, 1),
    },
    loopGuard: {
      enabled: flag(loopGuard.enabled, true),
      maxRepeats: Math.floor(bounded(loopGuard.maxRepeats, 4, 1, 100)),
      ignore: list(loopGuard.ignore, []),
    },
    plans: { enabled: flag(plans.enabled, true) },
    commands: flag(options.commands, true),
    syncVariants: flag(section(options.tui).syncVariants, true),
    log: {
      enabled: flag(log.enabled, true),
      path: text(log.path, defaultLogPath(env)),
      maxBytes: bounded(log.maxBytes, 5_000_000, 10_000, 1_000_000_000),
    },
    intentGate: {
      enabled: flag(intentGate.enabled, true),
      minConfidence: bounded(intentGate.minConfidence, 0.5, 0, 1),
      routes: Object.fromEntries(
        INTENTS.map((intent) => [intent, text(routes[intent], defaultRoutes[intent])]),
      ) as Record<Intent, string>,
    },
    approval: {
      enabled: flag(approval.enabled, false),
      dryRun: flag(approval.dryRun, true),
      riskThreshold: bounded(approval.riskThreshold, 0.2, 0, 1),
      prefixes: list(approval.prefixes, DEFAULT_PREFIXES),
    },
  };
}
