import type { ApprovalConfig } from "../config.js";
import { probability, type Decider, type Question } from "../jev.js";

export const QUESTIONS = {
  risk: {
    type: "noul",
    instructions:
      "Is this shell command dangerous to run without asking: does it delete or overwrite source files, rewrite git history, change a remote, send data over the network, install software, or reveal credentials?",
    criteria: {
      true: "It deletes, overwrites, pushes, uploads, downloads, installs, or reads secrets",
      false: "It only inspects the project, or runs the project's own local tests, build, type check, or linter",
    },
  },
} as const satisfies Record<string, Question>;

// Chaining, redirection, substitution, and expansion can hide a second command behind an approved prefix.
const SHELL_SYNTAX = /[;&|<>`\n\r\\]|\$[({]/;
const SECRET_PATH = /(^|\W)\.(env|ssh|aws|netrc|npmrc)\b|id_rsa|id_ed25519|\.(pem|key|p12|pfx)\b|secret|credential|token|passw/i;
const RISKY_FLAG = /(^|\s)(--exec|--output|--upload-pack|--receive-pack|--pre|-exec|-delete|--delete|--force|-o)(\s|=|$)/;

export type Screening = { readonly eligible: true } | { readonly eligible: false; readonly reason: string };

/** A lexical filter, not a shell parser: it only narrows what is sent for scoring and is not a security boundary. */
export function screen(command: string, prefixes: readonly string[]): Screening {
  const trimmed = command.trim();
  if (trimmed === "") return { eligible: false, reason: "empty command" };
  if (SHELL_SYNTAX.test(trimmed)) return { eligible: false, reason: "shell syntax" };
  if (SECRET_PATH.test(trimmed)) return { eligible: false, reason: "secret-like path" };
  if (RISKY_FLAG.test(trimmed)) return { eligible: false, reason: "risky flag" };
  if (!prefixes.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `))) {
    return { eligible: false, reason: "not an eligible prefix" };
  }
  return { eligible: true };
}

export interface ApprovalRecord {
  readonly time: number;
  readonly sessionID: string;
  readonly command: string;
  readonly risk: number;
  readonly approved: boolean;
  readonly dryRun: boolean;
}

export interface ApprovalGateDeps {
  readonly config: ApprovalConfig;
  readonly decider: Decider;
  readonly audit: (record: ApprovalRecord) => Promise<void>;
  readonly now?: () => number;
}

export interface EvaluateEvent {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  effect: "allow" | "ask" | "deny";
}

export type Outcome =
  | { readonly action: "skipped"; readonly reason: string }
  | { readonly action: "kept"; readonly risk: number }
  | { readonly action: "would-approve"; readonly risk: number }
  | { readonly action: "approved"; readonly risk: number };

export function createApprovalGate(deps: ApprovalGateDeps): (event: EvaluateEvent) => Promise<Outcome> {
  const now = deps.now ?? Date.now;

  return async (event) => {
    if (event.effect !== "ask") return { action: "skipped", reason: "not an ask" };
    if (event.action !== "shell") return { action: "skipped", reason: "not a shell command" };
    const [command, ...rest] = event.resources;
    if (command === undefined || rest.length > 0) return { action: "skipped", reason: "not a single command" };
    const screening = screen(command, deps.config.prefixes);
    if (!screening.eligible) return { action: "skipped", reason: screening.reason };

    const answers = await deps.decider.ask(command, QUESTIONS);
    const risk = answers && probability(answers, "risk");
    if (risk === undefined) return { action: "skipped", reason: "no decision" };

    const approved = risk <= deps.config.riskThreshold;
    try {
      await deps.audit({ time: now(), sessionID: event.sessionID, command, risk, approved, dryRun: deps.config.dryRun });
    } catch {
      // An approval that cannot be recorded is not granted.
      return { action: "skipped", reason: "audit failed" };
    }
    if (!approved) return { action: "kept", risk };
    if (deps.config.dryRun) return { action: "would-approve", risk };
    event.effect = "allow";
    return { action: "approved", risk };
  };
}
