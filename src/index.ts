import type { Plugin } from "@opencode/plugin";
import { applyAgents, assignedModels, type AgentEditor } from "./agents/register.js";
import { createCommands } from "./commands.js";
import { createApprovalGate } from "./hooks/approval.js";
import { createDoneGate } from "./hooks/done.js";
import { createIntentGate } from "./hooks/intent.js";
import { createLoopGuard } from "./hooks/loop.js";
import { createReportGate } from "./hooks/report.js";
import { runChecks } from "./lib/checks.js";
import { resolveConfig } from "./lib/config.js";
import { loadConfigSources } from "./lib/files.js";
import { createJevDecider } from "./lib/jev.js";
import { formatModel } from "./lib/models.js";
import { createPlanStore, renderActivePlan } from "./lib/plans.js";
import { createSessionLookup } from "./lib/sessions.js";

const MODEL_CHECK_DELAY_MS = 5_000;

function report(gate: string, error: unknown): void {
  console.error(`[foreman] ${gate} failed`, error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Catalog keys in the same form as `formatModel`, with and without each variant. */
function catalogKeys(models: unknown): Set<string> {
  const keys = new Set<string>();
  const entries = Array.isArray(models) ? models : isRecord(models) && Array.isArray(models.data) ? models.data : [];
  for (const model of entries) {
    if (!isRecord(model) || typeof model.providerID !== "string" || typeof model.id !== "string") continue;
    const base = `${model.providerID}/${model.id}`;
    keys.add(base);
    if (!Array.isArray(model.variants)) continue;
    for (const variant of model.variants) {
      if (isRecord(variant) && typeof variant.id === "string") keys.add(`${base}#${variant.id}`);
    }
  }
  return keys;
}

export default {
  id: "foreman",
  async setup(ctx) {
    const sources = loadConfigSources(ctx.options, ctx.location.directory);
    const warnings = [...sources.warnings];
    const config = resolveConfig(sources.raw, process.env, warnings);
    for (const warning of warnings) console.warn(`[foreman] ${warning}`);

    const cleanups: Array<() => void> = [];

    // OpenCode's editor uses branded IDs; the fields written here are plain strings underneath.
    await ctx.agent.transform((editor) => applyAgents(editor as unknown as AgentEditor, config.agents));

    const assigned = assignedModels(config.agents);
    if (assigned.size > 0) {
      // Providers can finish registering models after plugin setup, so the check waits and only warns.
      const timer = setTimeout(() => {
        void ctx.model
          .list()
          .then((models) => {
            const available = catalogKeys(models);
            if (available.size === 0) return;
            for (const [agent, model] of assigned) {
              const key = formatModel(model);
              if (!available.has(key)) console.warn(`[foreman] Agent "${agent}" is set to ${key}, which is not in the model catalog.`);
            }
          })
          .catch((error: unknown) => report("model check", error));
      }, MODEL_CHECK_DELAY_MS);
      cleanups.push(() => clearTimeout(timer));
    }

    const lookup = createSessionLookup(ctx.session);
    const plans = createPlanStore({
      get: (key) => ctx.storage.get(key),
      set: (key, value) => ctx.storage.set(key, value),
      remove: (key) => ctx.storage.remove(key),
    });
    const nudge = (description: string) => async (sessionID: string, text: string) => {
      await ctx.session.synthetic({ sessionID, text, description });
    };

    if (config.loopGuard.enabled) {
      const guard = createLoopGuard(config.loopGuard);
      await ctx.tool.hook("execute.before", (event) => guard(event));
    }

    if (config.plans.enabled) {
      await ctx.session.hook("context", async (event) => {
        const plan = await plans.active(event.sessionID).catch((error: unknown) => report("plan injection", error));
        if (plan) event.system.push({ type: "text", text: renderActivePlan(plan) });
      });
    }

    if (config.commands) {
      const commands = createCommands({
        bundledAgents: config.agents.bundled,
        plans,
        lookup,
        fallbackDirectory: ctx.location.directory,
        // The invocation is OpenCode's own object; only its text is replaced.
        send: async (input, text) => {
          await ctx.session.prompt({ ...(input as unknown as Parameters<typeof ctx.session.prompt>[0]), text });
        },
        switchAgent: (sessionID, agent) => ctx.session.switchAgent({ sessionID, agent }),
      });
      await ctx.command.transform((editor) => {
        for (const command of commands) {
          editor.add({
            name: command.name,
            description: command.description,
            execute: ({ sessionID, prompt, delivery }) =>
              command.execute({ sessionID, prompt, delivery } as unknown as Parameters<typeof command.execute>[0]),
          });
        }
      });
    }

    const decider = createJevDecider(config.jev);
    if (!decider) {
      console.warn("[foreman] No decision-model API key (jev.apiKey or FOREMAN_JEV_API_KEY); the gates are inactive.");
    } else {
      const isRoot = async (sessionID: string) => (await lookup(sessionID)).kind === "root";
      const { checks, checkTimeoutMs } = config.doneGate;

      const doneGate = config.doneGate.enabled
        ? createDoneGate({
            config: config.doneGate,
            decider,
            sessions: ctx.session,
            lookup,
            nudge: nudge("Foreman done gate"),
            runChecks: checks.length > 0 ? (directory) => runChecks(checks, directory, checkTimeoutMs) : undefined,
            activePlan: config.plans.enabled ? (sessionID) => plans.active(sessionID) : undefined,
            clearPlan: (sessionID) => plans.clear(sessionID),
          })
        : undefined;
      const reportGate = config.reportGate.enabled
        ? createReportGate({ config: config.reportGate, decider, sessions: ctx.session, lookup, nudge: nudge("Foreman report gate") })
        : undefined;

      if (doneGate || reportGate) {
        await ctx.session.hook("experimental.idle", async (event) => {
          // Each gate ignores the sessions that are not its own: root sessions for done, child sessions for report.
          await doneGate?.(event).catch((error: unknown) => report("done gate", error));
          await reportGate?.(event).catch((error: unknown) => report("report gate", error));
        });
      }

      if (config.intentGate.enabled) {
        const gate = createIntentGate({ config: config.intentGate, decider, isRoot });
        await ctx.session.hook("prompt", async (event) => {
          await gate.onPrompt(event).catch((error: unknown) => report("intent gate", error));
        });
        await ctx.session.hook("context", (event) => gate.onContext(event));
        cleanups.push(() => gate.clear());
      }

      if (config.approval.enabled) {
        let sequence = 0;
        const gate = createApprovalGate({
          config: config.approval,
          decider,
          audit: (record) => ctx.storage.set(`approval/${record.time}-${sequence++}`, { ...record }),
        });
        await ctx.permission.hook("evaluate", async (event) => {
          await gate(event).catch((error: unknown) => report("approval gate", error));
        });
      }
    }

    return () => cleanups.forEach((cleanup) => cleanup());
  },
} satisfies Plugin.Plugin;
