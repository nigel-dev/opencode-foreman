import type { Plugin } from "@opencode/plugin";
import { resolveConfig } from "./lib/config.js";
import { createApprovalGate } from "./hooks/approval.js";
import { createDoneGate } from "./hooks/done.js";
import { createIntentGate } from "./hooks/intent.js";
import { createJevDecider } from "./lib/jev.js";
import { createRootCheck } from "./lib/sessions.js";

function report(gate: string, error: unknown): void {
  console.error(`[foreman] ${gate} failed`, error);
}

export default {
  id: "foreman",
  async setup(ctx) {
    const config = resolveConfig(ctx.options);
    const decider = createJevDecider(config.jev);
    if (!decider) {
      console.warn("[foreman] No decision-model API key (jev.apiKey or FOREMAN_JEV_API_KEY); all gates are inactive.");
      return;
    }
    const isRoot = createRootCheck(ctx.session);
    const cleanups: Array<() => void> = [];

    if (config.doneGate.enabled) {
      const gate = createDoneGate({
        config: config.doneGate,
        decider,
        sessions: ctx.session,
        isRoot,
        nudge: async (sessionID, text) => {
          await ctx.session.synthetic({ sessionID, text, description: "Foreman done gate" });
        },
      });
      await ctx.session.hook("experimental.idle", async (event) => {
        await gate(event).catch((error: unknown) => report("done gate", error));
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

    return () => cleanups.forEach((cleanup) => cleanup());
  },
} satisfies Plugin.Plugin;
