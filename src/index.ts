import type { Plugin } from "@opencode/plugin";
import { applyAgents, assignedModels, type AgentEditor } from "./agents/register.js";
import { RepeatedCallError } from "./hooks/loop.js";
import { resolveConfig } from "./lib/config.js";
import { configDirectories, loadConfigSources } from "./lib/files.js";
import { createLoopHistories } from "./hooks/loop.js";
import { createDecisionLog, flattenAnswers, readRecentEntries } from "./lib/log.js";
import { formatModel } from "./lib/models.js";
import { createOperations } from "./lib/operations.js";
import { createPlanStore, renderActivePlan, type PlanStore } from "./lib/plans.js";
import { createSessionLookup } from "./lib/sessions.js";
import { createSessionState } from "./lib/state.js";
import { withTrace } from "./lib/trace.js";
import { watchConfig } from "./lib/watch.js";
import { foremanRpc, parseDecision, type Decision, type Gate, type Health, type RunningCheck, type Status } from "./rpc.js";
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

/** Attachments keep their content but lose their position in the text, which the command has rewritten. */
function withoutMentions(items: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  return items.filter(isRecord).map(({ mention: _mention, ...rest }) => rest);
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
    let disposed = false;

    const load = () => {
      const sources = loadConfigSources(ctx.options, directory);
      const warnings = [...sources.warnings];
      const config = resolveConfig(sources.raw, process.env, warnings);
      for (const warning of warnings) console.warn(`[foreman] ${warning}`);
      return { config, warnings, files: sources.files, invalid: sources.invalid };
    };

    const operations = createOperations();
    const checks = new Map<string, RunningCheck>();
    let health: Health = { state: "unknown" };

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
          health: runtime.decisionModel ? health : { state: "off" },
          paused: sessionID ? (await state.read(sessionID)).paused === true : false,
          check: (sessionID && checks.get(sessionID)) || null,
        };
      },
      cancelCheck: async (input) => {
        const sessionID = isRecord(input) && typeof input.sessionID === "string" ? input.sessionID : "";
        return { cancelled: checks.has(sessionID) && operations.cancel(sessionID) };
      },
    });
    const emit = (send: () => Promise<void>) => void send().catch((error: unknown) => report("event", error));

    const lookup = createSessionLookup(ctx.session);
    const state = createSessionState({
      get: (key) => ctx.storage.get(key),
      set: (key, value) => ctx.storage.set(key, value as Parameters<typeof ctx.storage.set>[1]),
      remove: (key) => ctx.storage.remove(key),
    });
    const loopHistories = createLoopHistories();
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
        state,
        loopHistories,
        fallbackDirectory: directory,
        nudge: (description) => async (sessionID, text) => {
          await ctx.session.synthetic({ sessionID, text, description });
        },
        audit: (record) => ctx.storage.set(`approval/${record.time}-${sequence++}`, { ...record }),
        onDecisionModel: (outcome) => {
          const next: Health = outcome.ok ? { state: "ok", time: Date.now() } : { state: "failing", detail: outcome.reason, time: Date.now() };
          const changed = next.state !== health.state || next.detail !== health.detail;
          health = next;
          if (!changed) return;
          if (next.state === "failing") console.warn(`[foreman] The decision model ${next.detail}; the gates that use it are doing nothing until it answers.`);
          emit(() => rpc.events.emit("health", { state: next.state, ...(next.detail ? { detail: next.detail } : {}) }));
        },
        onCheck: (sessionID, progress) => {
          if (progress) checks.set(sessionID, { ...progress, startedAt: Date.now() });
          else checks.delete(sessionID);
          emit(() => rpc.events.emit("session", { sessionID }));
        },
        send: async (input, text) => {
          const files = withoutMentions(input.prompt.files);
          const skills = withoutMentions(input.prompt.skills);
          const agents = withoutMentions(input.prompt.agents);
          const prompt = {
            sessionID: input.sessionID,
            text,
            ...(files ? { files } : {}),
            ...(skills ? { skills } : {}),
            ...(agents ? { agents } : {}),
            ...(input.delivery === "steer" || input.delivery === "queue" ? { delivery: input.delivery } : {}),
          };
          // The attachment shapes are OpenCode's own, passed through unchanged apart from their text offsets.
          await ctx.session.prompt(prompt as unknown as Parameters<typeof ctx.session.prompt>[0]);
        },
        switchAgent: async (sessionID, agent) => {
          await ctx.session.switchAgent({ sessionID, agent });
          // A session keeps its own model when its agent changes, so the agent's configured model is applied too.
          const model = assignedModels(runtime.config.agents).get(agent);
          if (model) await ctx.session.switchModel({ sessionID, model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) } });
        },
        setPaused: async (sessionID, paused) => {
          await state.update(sessionID, { paused });
          if (paused) operations.cancel(sessionID);
          record("done", sessionID, { action: paused ? "paused" : "resumed", reason: "by command" });
          emit(() => rpc.events.emit("session", { sessionID }));
        },
      });

    const initial = load();
    configFiles = initial.files;
    let runtime = build(initial.config);
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
    function record(
      gate: Gate,
      sessionID: string,
      outcome: { action: string; reason: string; detail?: string | undefined },
      trace?: { answers?: Parameters<typeof flattenAnswers>[0] | undefined; elapsedMs?: number | undefined },
    ): void {
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
    }

    // OpenCode's editor uses branded IDs; the fields written here are plain strings underneath.
    await ctx.agent.transform((editor) => applyAgents(editor as unknown as AgentEditor, runtime.config.agents));

    await ctx.command.transform((editor) => {
      for (const command of runtime.commands) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: ({ sessionID, prompt, delivery }) => command.execute({ sessionID, prompt: prompt as unknown as { text: string }, delivery }),
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
        runtime.loopGuard?.check(event);
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
      if (disposed) return;
      // Each gate ignores the sessions that are not its own: root sessions for done, child sessions for report.
      const { doneGate, reportGate } = runtime;
      if (!doneGate && !reportGate) return;
      const operation = operations.begin(event.sessionID);
      try {
        if (doneGate) {
          await withTrace(() => doneGate(event, operation))
            .then(({ result, ...trace }) => {
              if (result.reason !== "not a root session") record("done", event.sessionID, result, trace);
            })
            .catch((error: unknown) => report("done gate", error));
        }
        if (reportGate) {
          await withTrace(() => reportGate(event, operation))
            .then(({ result, ...trace }) => {
              if (result.reason !== "not a subagent session") record("report", event.sessionID, result, trace);
            })
            .catch((error: unknown) => report("report gate", error));
        }
      } finally {
        operation.end();
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

    // Pressing Stop does not stop a hook that is already running, so a stopped session's gate run is
    // cancelled here: its check is killed and nothing more is sent into the session.
    const events = new AbortController();
    cleanups.push(() => events.abort());
    void (async () => {
      const types = ["session.execution.interrupted", "session.inbox.enqueued", "session.deleted"] as const;
      for await (const event of ctx.event.subscribe({ types: [...types], signal: events.signal })) {
        const { sessionID } = event.data;
        if (event.type === "session.inbox.enqueued") {
          // Only a user request the session has actually accepted counts; the prompt hook also runs for
          // submissions that are later rejected. Other locations' sessions belong to their own instance.
          if (event.data.item.type !== "user" || (event.location && event.location.directory !== directory)) continue;
          // A new request makes any verdict still being worked out stale, and starts the loop guard afresh.
          operations.cancel(sessionID);
          loopHistories.delete(sessionID);
          // Recorded so the gates still know the request after compaction drops it from the context window.
          await state
            .update(sessionID, { request: { id: event.data.inboxID, text: event.data.item.payload.text } })
            .catch((error: unknown) => report("request record", error));
          continue;
        }
        operations.cancel(sessionID);
        if (event.type === "session.deleted") {
          loopHistories.delete(sessionID);
          await Promise.all([state.remove(sessionID), storedPlans.clear(sessionID)]).catch((error: unknown) => report("session cleanup", error));
        }
      }
    })().catch((error: unknown) => {
      if (!events.signal.aborted) report("event subscription", error);
    });

    // Reloads run one at a time, and none starts or finishes its work after the plugin has unloaded.
    let reloading: Promise<void> = Promise.resolve();
    const reload = async () => {
      if (disposed) return;
      const { config, warnings, files, invalid } = load();
      if (invalid) {
        // A file caught mid-edit must not switch the project to the settings that are left without it.
        console.warn("[foreman] A config file could not be read; keeping the settings already in use.");
        emit(() => rpc.events.emit("config", { files: [...configFiles], warnings: [...warnings], applied: false }));
        return;
      }
      runtime.intentGate?.clear();
      runtime = build(config);
      configFiles = files;
      log = createDecisionLog(config.log);
      // Both transforms read the current runtime, so replaying them applies the new agents and commands.
      await ctx.agent.reload();
      if (disposed) return;
      await ctx.command.reload();
      if (disposed) return;
      scheduleModelCheck();
      console.warn(`[foreman] Config reloaded from ${configFiles.length > 0 ? configFiles.join(", ") : "defaults"}.`);
      emit(() => rpc.events.emit("config", { files: [...configFiles], warnings, applied: true }));
    };
    cleanups.push(
      watchConfig(configDirectories(directory), () => {
        reloading = reloading.then(reload).catch((error: unknown) => report("config reload", error));
      }),
    );
    cleanups.push(() => runtime.intentGate?.clear());

    return () => {
      disposed = true;
      operations.cancelAll();
      cleanups.forEach((cleanup) => cleanup());
    };
  },
} satisfies Plugin.Plugin;
