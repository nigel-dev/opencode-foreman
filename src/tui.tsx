import { Plugin as Tui } from "@opencode/plugin/tui";
import { Show, createEffect, createSignal, type Accessor } from "solid-js";
import { foremanRpc, parseDecision, parseHealth, parseStatus, type Status } from "./rpc.js";
import { checkText, decisionToast, describeDecision, desiredVariant, gateLabel, planSummary, progressBar, statusReport, type AgentModel } from "./tui/format.js";

const COMMAND = "foreman.status";
const CANCEL_COMMAND = "foreman.cancel-check";

export default Tui.define({
  id: "foreman-tui",
  setup(context) {
    const rpc = context.client.rpc(foremanRpc);
    const cleanups: Array<() => void> = [];
    const at = () => {
      const directory = context.location?.directory;
      return directory ? { location: { directory } } : undefined;
    };
    // RPC events arrive from every location; only this project's are shown.
    const mine = (event: { location?: { directory?: string } }) => {
      const directory = context.location?.directory;
      return !directory || !event.location?.directory || event.location.directory === directory;
    };

    const [statuses, setStatuses] = createSignal<ReadonlyMap<string, Status>>(new Map());
    const requested = new Set<string>();

    const refresh = async (sessionID: string): Promise<Status | undefined> => {
      try {
        const status = parseStatus(await rpc.status({ sessionID }, at()));
        if (status) setStatuses((current) => new Map(current).set(sessionID, status));
        return status;
      } catch {
        // The server part may be disabled or still loading; the views simply stay empty.
        return undefined;
      }
    };

    /** Reactive status for a session, fetched the first time something asks for it. */
    const statusOf = (sessionID: string | undefined): Status | undefined => {
      if (!sessionID) return undefined;
      if (!requested.has(sessionID)) {
        requested.add(sessionID);
        void refresh(sessionID);
      }
      return statuses().get(sessionID);
    };

    const refreshKnown = (sessionID: string) => {
      if (requested.has(sessionID)) void refresh(sessionID);
    };

    cleanups.push(
      rpc.events.on("decision", (event) => {
        if (!mine(event)) return;
        const decision = parseDecision(event.data);
        if (!decision) return;
        refreshKnown(decision.sessionID);
        const toast = decisionToast(decision);
        if (toast) context.ui.toast.show({ ...toast, sessionID: decision.sessionID });
      }),
      rpc.events.on("plan", (event) => {
        if (!mine(event)) return;
        const sessionID = (event.data as { sessionID?: unknown }).sessionID;
        if (typeof sessionID === "string") refreshKnown(sessionID);
      }),
      rpc.events.on("session", (event) => {
        if (!mine(event)) return;
        const sessionID = (event.data as { sessionID?: unknown }).sessionID;
        if (typeof sessionID === "string") refreshKnown(sessionID);
      }),
      rpc.events.on("health", (event) => {
        if (!mine(event)) return;
        const health = parseHealth(event.data);
        if (health.state === "failing") {
          context.ui.toast.show({
            title: "Foreman",
            message: `The decision model is not answering (${health.detail ?? "unknown error"}). The gates that use it are doing nothing.`,
            variant: "warning",
          });
        } else if (health.state === "ok") {
          context.ui.toast.show({ title: "Foreman", message: "The decision model is answering again.", variant: "success" });
        }
        for (const sessionID of requested) void refresh(sessionID);
      }),
      rpc.events.on("config", (event) => {
        if (!mine(event)) return;
        const { warnings, applied } = event.data as { warnings?: unknown; applied?: unknown };
        const count = Array.isArray(warnings) ? warnings.length : 0;
        context.ui.toast.show({
          title: "Foreman",
          message:
            applied === false
              ? "A config file could not be read, so the previous settings are still in use. See the server log."
              : count > 0
                ? `Config reloaded with ${count} warning${count === 1 ? "" : "s"}; see the server log.`
                : "Config reloaded.",
          variant: applied === false || count > 0 ? "warning" : "success",
        });
        for (const sessionID of requested) void refresh(sessionID);
        void loadSettings();
      }),
      // Ticking a plan checkbox is a file edit, not an event, so progress is re-read whenever a turn ends.
      context.data.on("session.execution.succeeded", (event) => refreshKnown(event.data.sessionID)),
    );

    const [syncVariants, setSyncVariants] = createSignal(false);
    const loadSettings = async () => {
      try {
        setSyncVariants(parseStatus(await rpc.status({}, at()))?.syncVariants ?? false);
        await context.data.location.agent.sync(context.location);
      } catch {
        // Without the server part there is nothing to sync to.
      }
    };
    void loadSettings();

    // The TUI remembers the last variant picked for each model and applies it over an agent's configured
    // one. When the prompt's model changes, this puts the configured variant back. A variant the user
    // picks afterwards stays until the model changes again. Only the model is tracked: the session's agent
    // becomes known when the first prompt creates the session, and that must not undo a variant just picked.
    const VariantSync = () => {
      let settled: string | undefined;
      createEffect(() => {
        const current = context.ui.model.current();
        const agents = context.data.location.agent.list(context.location) as readonly AgentModel[] | undefined;
        if (!syncVariants() || !current || !agents || agents.length === 0) return;
        const stamp = `${current.providerID}/${current.modelID}`;
        if (stamp === settled) return;
        settled = stamp;
        const route = context.ui.router.current();
        const sessionAgent = route.type === "session" ? context.data.session.get(route.sessionID)?.agent : undefined;
        const wanted = desiredVariant(agents, current, sessionAgent);
        if (wanted && wanted !== current.variant) context.ui.model.variant.set(wanted);
      });
      return null;
    };
    cleanups.push(context.ui.slot({ append: "app", render: () => <VariantSync /> }));

    // Drives the elapsed time of a running check; only views showing one read it.
    const [now, setNow] = createSignal(Date.now());
    const ticker = setInterval(() => setNow(Date.now()), 1_000);
    cleanups.push(() => clearInterval(ticker));

    const Footer = (props: { sessionID: Accessor<string | undefined> }) => {
      const status = () => statusOf(props.sessionID());
      const summary = () => planSummary(status());
      const check = () => checkText(status(), now());
      return (
        <box flexDirection="row" gap={1} flexShrink={0} onMouseUp={() => context.keymap.dispatch(COMMAND)}>
          <Show when={check()}>
            <text fg={context.theme.text.feedback.warning.base}>{check()}</text>
          </Show>
          <Show when={status()?.paused}>
            <text fg={context.theme.text.muted}>foreman paused</text>
          </Show>
          <Show when={summary()}>
            <text fg={context.theme.text.muted}>plan</text>
            <text fg={context.theme.text.base}>{summary()}</text>
          </Show>
        </box>
      );
    };

    const Sidebar = (props: { sessionID: Accessor<string> }) => {
      const status = () => statusOf(props.sessionID());
      const last = () => status()?.decisions[0];
      return (
        <Show when={status()?.plan || last() || status()?.check || status()?.paused}>
          <box flexDirection="column" onMouseUp={() => context.keymap.dispatch(COMMAND)}>
            <text fg={context.theme.text.base}>
              <b>Foreman</b>
            </text>
            <Show when={status()?.plan}>
              <text fg={context.theme.text.base} wrapMode="none" truncate>
                {planSummary(status())}
              </text>
              <Show when={progressBar(status())}>
                <text fg={context.theme.text.feedback.success.base}>{progressBar(status())}</text>
              </Show>
            </Show>
            <Show when={checkText(status(), now())}>
              <text fg={context.theme.text.feedback.warning.base}>{checkText(status(), now())}</text>
            </Show>
            <Show when={status()?.paused}>
              <text fg={context.theme.text.muted}>Supervision paused</text>
            </Show>
            <Show when={last()}>
              {(decision) => (
                <text fg={context.theme.text.muted}>
                  {gateLabel(decision().gate)}: {describeDecision(decision())}
                </text>
              )}
            </Show>
          </box>
        </Show>
      );
    };

    cleanups.push(
      context.ui.slot({ append: "prompt.footer.status", render: (input) => <Footer sessionID={() => input.sessionID} /> }),
      context.ui.slot({ append: "sidebar.content", render: (input) => <Sidebar sessionID={() => input.sessionID} /> }),
    );

    const showStatus = async () => {
      const route = context.ui.router.current();
      if (route.type !== "session") {
        context.ui.toast.show({ title: "Foreman", message: "Open a session to see its Foreman status.", variant: "info" });
        return;
      }
      const status = await refresh(route.sessionID);
      requested.add(route.sessionID);
      if (!status) {
        context.ui.toast.show({ title: "Foreman", message: "The Foreman server plugin did not answer. Check that it is loaded.", variant: "warning" });
        return;
      }
      await context.ui.dialog.alert({ title: "Foreman", message: statusReport(status, (path) => context.ui.format.path(path)) });
    };

    const cancelCheck = async () => {
      const route = context.ui.router.current();
      if (route.type !== "session") return;
      try {
        const result = (await rpc.cancelCheck({ sessionID: route.sessionID }, at())) as { cancelled?: unknown };
        context.ui.toast.show({
          title: "Foreman",
          message: result.cancelled === true ? "Stopped the running check." : "No check is running in this session.",
          variant: "info",
        });
      } catch {
        context.ui.toast.show({ title: "Foreman", message: "The Foreman server plugin did not answer.", variant: "warning" });
      }
    };

    // Removed by the host when the plugin deactivates.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: COMMAND,
          title: "Foreman: Show status",
          description: "Show this session's active plan, gates, and recent decisions",
          group: "Foreman",
          palette: true,
          slash: { name: "foreman" },
          run: () => {
            void showStatus();
          },
        },
        {
          id: CANCEL_COMMAND,
          title: "Foreman: Cancel running check",
          description: "Stop the project check Foreman is running for this session",
          group: "Foreman",
          palette: true,
          slash: { name: "foreman-cancel-check" },
          run: () => {
            void cancelCheck();
          },
        },
      ],
    }));

    return () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
  },
});
