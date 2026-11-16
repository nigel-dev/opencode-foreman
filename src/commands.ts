import { PLAN_DIRECTORY } from "./agents/types.js";
import { resolvePlan, type PlanStore } from "./lib/plans.js";
import type { SessionFacts } from "./lib/sessions.js";

export interface CommandInvocation {
  readonly sessionID: string;
  /** OpenCode's prompt, passed through so attachments reach the submitted prompt. Only `text` is read here. */
  readonly prompt: { readonly text: string } & Readonly<Record<string, unknown>>;
  readonly delivery?: unknown;
}

export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly execute: (input: CommandInvocation) => Promise<void>;
}

export interface CommandDeps {
  /** Whether a bundled agent is registered and enabled; a command is only offered when the agent it needs is. */
  readonly available: (agent: string) => boolean;
  readonly plans: PlanStore;
  readonly lookup: (sessionID: string) => Promise<SessionFacts>;
  readonly fallbackDirectory: string;
  /** Submits a user prompt to the session, keeping the invocation's attachments and delivery mode. */
  readonly send: (input: CommandInvocation, text: string) => Promise<void>;
  /** Switches the session to an agent and to that agent's configured model, when it has one. */
  readonly switchAgent: (sessionID: string, agent: string) => Promise<void>;
  /** Pauses or resumes supervision for the session. Sends nothing into the session. */
  readonly setPaused: (sessionID: string, paused: boolean) => Promise<void>;
}

const HANDOFF = `Write a handoff so this work can continue in a fresh session with no memory of this one. Write it for a reader who has seen none of this conversation. Use these sections:

- **Goal**: what we are trying to achieve and why.
- **State**: what is done, and what is in progress.
- **Decisions**: choices made and the reason for each, so they are not reopened.
- **Files**: the files changed or central to the work, with paths.
- **Checks**: which tests, builds, or other checks were run and their actual results; say what was not checked.
- **Open issues**: known problems, risks, and questions waiting on the user.
- **Next step**: the first thing the next session should do.

Check the facts against the repository before you write them; do not rely on memory for file paths or check results. Reply with the handoff only.`;

export function createCommands(deps: CommandDeps): CommandDefinition[] {
  const directoryOf = async (sessionID: string) => (await deps.lookup(sessionID)).directory ?? deps.fallbackDirectory;

  const commands: CommandDefinition[] = [
    {
      name: "handoff",
      description: "Summarise this session so the work can continue in a new one",
      execute: (input) => {
        const focus = input.prompt.text.trim();
        return deps.send(input, focus ? `${HANDOFF}\n\nPay particular attention to: ${focus}` : HANDOFF);
      },
    },
    {
      name: "stop-work",
      description: "Stop tracking the active Foreman plan in this session",
      execute: async (input) => {
        const path = await deps.plans.clear(input.sessionID);
        await deps.send(
          input,
          path
            ? `Foreman is no longer tracking the plan at \`${path}\` in this session. Stop working through it and confirm in one sentence where it stands.`
            : "Foreman is not tracking a plan in this session right now; any earlier plan was finished or already stopped. Say so in one sentence.",
        );
      },
    },
  ];

  commands.push(
    {
      name: "foreman-pause",
      description: "Pause Foreman's done gate, checks, and report gate for this session",
      execute: (input) => deps.setPaused(input.sessionID, true),
    },
    {
      name: "foreman-resume",
      description: "Resume Foreman's supervision for this session",
      execute: (input) => deps.setPaused(input.sessionID, false),
    },
  );

  if (deps.available("planner")) {
    commands.push({
      name: "plan",
      description: "Switch to the planner and plan the described work",
      execute: async (input) => {
        await deps.switchAgent(input.sessionID, "planner");
        const request = input.prompt.text.trim();
        await deps.send(input, request || "I want to plan some work. Ask me what it is.");
      },
    });
  }

  if (deps.available("orchestrator")) {
    commands.push({
      name: "start-work",
      description: `Carry out a plan from ${PLAN_DIRECTORY}/ with the orchestrator`,
      execute: async (input) => {
        const plan = resolvePlan(await directoryOf(input.sessionID), input.prompt.text);
        if (!plan.found) {
          await deps.send(input, `I tried to start work on a plan, but: ${plan.reason} Tell me that and stop.`);
          return;
        }
        await deps.plans.activate(input.sessionID, plan.path);
        await deps.switchAgent(input.sessionID, "orchestrator");
        await deps.send(
          input,
          `Carry out the plan at \`${plan.path}\`. Read it fully first, then work through its open tasks in order, ticking each checkbox in the plan file once the task is done and verified.`,
        );
      },
    });
  }

  if (deps.available("reviewer")) {
    commands.push({
      name: "review-work",
      description: "Have the reviewer subagent independently review the current changes",
      execute: (input) => {
        const focus = input.prompt.text.trim();
        return deps.send(
          input,
          `Send the \`reviewer\` subagent to review the current changes in this repository. Give it what the changes were meant to achieve${focus ? ` and ask it to focus on: ${focus}` : ""}. When it reports, give me its verdict and findings in order of severity. Do not fix anything until I say so.`,
        );
      },
    });
  }
  return commands;
}
