import type { Plugin } from "@opencode/plugin";
import { applyAgents, assignedModels, type AgentEditor } from "./agents/register.js";
import { RepeatedCallError } from "./hooks/loop.js";
import { resolveConfig } from "./lib/config.js";
import { configDirectories, loadConfigSources } from "./lib/files.js";
import { createDecisionLog, flattenAnswers, readRecentEntries } from "./lib/log.js";
import { formatModel } from "./lib/models.js";
import { createPlanStore, renderActivePlan, type PlanStore } from "./lib/plans.js";
import { createSessionLookup } from "./lib/sessions.js";
import { withTrace } from "./lib/trace.js";
import { watchConfig } from "./lib/watch.js";
import { foremanRpc, parseDecision, type Decision, type Gate, type Status } from "./rpc.js";
import { buildRuntime, type Runtime } from "./runtime.js";

const MODEL_CHECK_DELAY_MS = 5_000;
const RECENT_LIMIT = 100;
const STATUS_DECISIONS = 20;

function report(what: string, error: unknown): void {
  console.error(`[foreman] ${what} failed`, error);
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

function planName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

export default {
  id: "foreman",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const cleanups: Array<() => void> = [];
    const recent: Decision[] = [];
    let configFiles: readonly string[] = [];

    const load = () => {
      const sources = loadConfigSources(ctx.options, directory);
      const warnings = [...sources.warnings];
      const config = resolveConfig(sources.raw, process.env, warnings);
      for (const warning of warnings) console.warn(`[foreman] ${warning}`);
      configFiles = sources.files;
      return { config, warnings };
    };

    const rpc = await ctx.rpc.register(foremanRpc, {
      status: async (input): Promise<Status> => {
        const sessionID = isRecord(input) && typeof input.sessionID === "string" ? input.sessionID : undefined;
        const plan = sessionID && runtime.config.plans.enabled ? await plans.active(sessionID) : undefined;
        const { config } = runtime;
        return {
          plan: plan ? { name: planName(plan.path), path: plan.path, ...plan.progress } : null,
          decisions: recent.filter((decision) => !sessionID || decision.sessionID === sessionID).slice(0, STATUS_DECISIONS),
          gates: {
            done: runtime.doneGate !== undefined,
            report: runtime.reportGate !== undefined,
            intent: runtime.intentGate !== undefined,
            approval: runtime.approvalGate !== undefined,
            loop: runtime.loopGuard !== undefined,
          },
          decisionModel: runtime.decisionModel,
          configFiles,
          logFile: config.log.enabled ? config.log.path : null,
          syncVariants: config.syncVariants,
        };
      },
    });
    const emit = (send: () => Promise<void>) => void send().catch((error: unknown) => report("event", error));

    const lookup = createSessionLookup(ctx.session);
    const storedPlans = createPlanStore({
      get: (key) => ctx.storage.get(key),
      set: (key, value) => ctx.storage.set(key, value),
      remove: (key) => ctx.storage.remove(key),
    });
    // The TUI shows plan progress, so it is told whenever a session's plan starts or stops being tracked.
    const plans: PlanStore = {
      active: (sessionID) => storedPlans.active(sessionID),
      activate: async (sessionID, path) => {
        await storedPlans.activate(sessionID, path);
        emit(() => rpc.events.emit("plan", { sessionID }));
      },
      clear: async (sessionID) => {
        const path = await storedPlans.clear(sessionID);
        if (path) emit(() => rpc.events.emit("plan", { sessionID }));
        return path;
      },
    };

    let sequence = 0;
    const build = (config: Runtime["config"]): Runtime =>
      buildRuntime(config, {
        sessions: ctx.session,
        lookup,
        plans,
        fallbackDirectory: directory,
        nudge: (description) => async (sessionID, text) => {
          await ctx.session.synthetic({ sessionID, text, description });
        },
        audit: (record) => ctx.storage.set(`approval/${record.time}-${sequence++}`, { ...record }),
        // The invocation is OpenCode's own object; only its text is replaced.
        send: async (input, text) => {
          await ctx.session.prompt({ ...(input as unknown as Parameters<typeof ctx.session.prompt>[0]), text });
        },
        switchAgent: (sessionID, agent) => ctx.session.switchAgent({ sessionID, agent }),
      });

    let runtime = build(load().config);
    let log = createDecisionLog(runtime.config.log);
    if (runtime.config.log.enabled) {
      // OpenCode reloads plugins freely, so the status view is seeded from the log rather than starting empty.
      for (const entry of await readRecentEntries(runtime.config.log.path, RECENT_LIMIT * 4)) {
        if (entry.directory !== directory || recent.length >= RECENT_LIMIT) continue;
        const decision = parseDecision({ ...entry, time: typeof entry.time === "string" ? Date.parse(entry.time) : entry.time });
        if (decision) recent.push(decision);
      }
    }
    if (!runtime.decisionModel) {
      console.warn("[foreman] No decision-model API key (jev.apiKey or FOREMAN_JEV_API_KEY); only the loop guard, commands, and plan tracking are active.");
    }

    /** Keeps a decision for the status view, writes it to the log, and tells the TUI. */
    const record = (
      gate: Gate,
      sessionID: string,
      outcome: { action: string; reason: string; detail?: string | undefined },
      trace?: { answers?: Parameters<typeof flattenAnswers>[0] | undefined; elapsedMs?: number | undefined },
    ) => {
      const decision: Decision = {
        time: Date.now(),
        sessionID,
        gate,
        action: outcome.action,
        reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
      recent.unshift(decision);
      if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
      void log.write({
        ...decision,
        time: new Date(decision.time).toISOString(),
        directory,
        ...(trace?.answers ? { answers: flattenAnswers(trace.answers), jevMs: trace.elapsedMs } : {}),
      });
      emit(() => rpc.events.emit("decision", { ...decision }));
    };

    // OpenCode's editor uses branded IDs; the fields written here are plain strings underneath.
    await ctx.agent.transform((editor) => applyAgents(editor as unknown as AgentEditor, runtime.config.agents));

    await ctx.command.transform((editor) => {
      for (const command of runtime.commands) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: ({ sessionID, prompt, delivery }) =>
            command.execute({ sessionID, prompt, delivery } as unknown as Parameters<typeof command.execute>[0]),
        });
      }
    });

    let modelCheck: ReturnType<typeof setTimeout> | undefined;
    const scheduleModelCheck = () => {
      clearTimeout(modelCheck);
      const assigned = assignedModels(runtime.config.agents);
      if (assigned.size === 0) return;
      // Providers can finish registering models after plugin setup, so the check waits and only warns.
      modelCheck = setTimeout(() => {
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
    };
    scheduleModelCheck();
    cleanups.push(() => clearTimeout(modelCheck));

    await ctx.tool.hook("execute.before", (event) => {
      try {
        runtime.loopGuard?.(event);
      } catch (error) {
        if (error instanceof RepeatedCallError) {
          record("loop", event.sessionID, { action: "blocked", reason: error.cycle === 1 ? "repeated call" : "repeated cycle", detail: event.tool });
        }
        throw error;
      }
    });

    await ctx.session.hook("context", async (event) => {
      if (runtime.config.plans.enabled) {
        const plan = await plans.active(event.sessionID).catch((error: unknown) => report("plan injection", error));
        if (plan) event.system.push({ type: "text", text: renderActivePlan(plan) });
      }
      runtime.intentGate?.onContext(event);
    });

    await ctx.session.hook("experimental.idle", async (event) => {
      // Each gate ignores the sessions that are not its own: root sessions for done, child sessions for report.
      const { doneGate, reportGate } = runtime;
      if (doneGate) {
        await withTrace(() => doneGate(event))
          .then(({ result, ...trace }) => {
            if (result.reason !== "not a root session") record("done", event.sessionID, result, trace);
          })
          .catch((error: unknown) => report("done gate", error));
      }
      if (reportGate) {
        await withTrace(() => reportGate(event))
          .then(({ result, ...trace }) => {
            if (result.reason !== "not a subagent session") record("report", event.sessionID, result, trace);
          })
          .catch((error: unknown) => report("report gate", error));
      }
    });

    await ctx.session.hook("prompt", async (event) => {
      const gate = runtime.intentGate;
      if (!gate) return;
      await withTrace(() => gate.onPrompt(event))
        .then(({ result, ...trace }) => {
          if (result) {
            const reason = `${result.intent}, ${result.complexity}${result.ambiguous ? ", ambiguous" : ""}`;
            record("intent", event.sessionID, { action: "hint", reason }, trace);
          } else if (trace.answers) {
            record("intent", event.sessionID, { action: "none", reason: "low confidence" }, trace);
          }
        })
        .catch((error: unknown) => report("intent gate", error));
    });

    await ctx.permission.hook("evaluate", async (event) => {
      const gate = runtime.approvalGate;
      if (!gate) return;
      await withTrace(() => gate(event))
        .then(({ result, ...trace }) => {
          if (result.action === "skipped") return;
          record("approval", event.sessionID, { action: result.action, reason: `risk ${result.risk}`, detail: event.resources[0] }, trace);
        })
        .catch((error: unknown) => report("approval gate", error));
    });

    const reload = async () => {
      const { config, warnings } = load();
      runtime.intentGate?.clear();
      runtime = build(config);
      log = createDecisionLog(config.log);
      // Both transforms read the current runtime, so replaying them applies the new agents and commands.
      await ctx.agent.reload();
      await ctx.command.reload();
      scheduleModelCheck();
      console.warn(`[foreman] Config reloaded from ${configFiles.length > 0 ? configFiles.join(", ") : "defaults"}.`);
      emit(() => rpc.events.emit("config", { files: [...configFiles], warnings }));
    };
    cleanups.push(watchConfig(configDirectories(directory), () => void reload().catch((error: unknown) => report("config reload", error))));
    cleanups.push(() => runtime.intentGate?.clear());

    return () => cleanups.forEach((cleanup) => cleanup());
  },
} satisfies Plugin.Plugin;
