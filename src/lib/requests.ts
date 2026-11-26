import { BoundedMap } from "./sessions.js";

// One queue per session for the whole process, however many plugin instances there are, so a write still
// in flight in an instance that has been unloaded cannot land after a newer one from its replacement.
const QUEUES = Symbol.for("opencode-foreman.session.queues");
function queues(): Map<string, Promise<void>> {
  const holder = globalThis as { [QUEUES]?: Map<string, Promise<void>> };
  return (holder[QUEUES] ??= new Map());
}

/** Runs storage work for a session in the background, one task at a time, in the order it was started. */
export function inOrder(sessionID: string, task: () => Promise<void>, report: (error: unknown) => void): void {
  const all = queues();
  const next = (all.get(sessionID) ?? Promise.resolve()).then(task).catch(report);
  all.set(sessionID, next);
  void next.then(() => {
    if (all.get(sessionID) === next) all.delete(sessionID);
  });
}

export interface RequestTrackerDeps {
  /** The text of a delivered message, read back from the session; undefined unless it is a user message. */
  userText(sessionID: string, inboxID: string): Promise<string | undefined>;
  /**
   * Cancels the gate run in progress for a session. Called the moment anything is delivered, never later:
   * the session is starting a new turn, so a verdict on the previous one is stale, and a gate run that
   * starts after this point belongs to the new turn and must be left alone.
   */
  cancelStale(sessionID: string): void;
  /** A new request starts the loop guard afresh. */
  startRequest(sessionID: string): void;
  /** Recorded so the gates still know the request after compaction drops it from the context window. */
  persist(sessionID: string, request: { id: string; text: string }): Promise<void>;
  report(error: unknown): void;
}

export interface RequestTracker {
  enqueued(inboxID: string, text: string): void;
  cancelled(inboxID: string): void;
  delivered(sessionID: string, inboxID: string): void;
}

/**
 * Follows a session's inbox so the request it is working on is known. Nothing here is awaited by the
 * caller: a slow read or write for one session must never hold up the Stop of another.
 */
export function createRequestTracker(deps: RequestTrackerDeps): RequestTracker {
  // Requests the session has accepted but not started on yet, by inbox ID.
  const pending = new BoundedMap<string, string>();
  // How many messages each session has started on, to tell when a slow lookup has been overtaken.
  const deliveries = new BoundedMap<string, number>();

  return {
    enqueued(inboxID, text) {
      pending.set(inboxID, text);
    },
    cancelled(inboxID) {
      pending.delete(inboxID);
    },
    delivered(sessionID, inboxID) {
      // Only now is it the request the session is working on. One queued behind a running turn, or
      // cancelled before it started, never replaces the request that turn is answering.
      const delivery = (deliveries.get(sessionID) ?? 0) + 1;
      deliveries.set(sessionID, delivery);
      const known = pending.get(inboxID);
      pending.delete(inboxID);
      deps.cancelStale(sessionID);
      if (known !== undefined) {
        deps.startRequest(sessionID);
        inOrder(sessionID, () => deps.persist(sessionID, { id: inboxID, text: known }), deps.report);
        return;
      }
      // The plugin was reloaded between the message being queued and delivered, so its text is read back
      // from the session. Anything that is not a user message (a nudge, say) is ignored.
      inOrder(
        sessionID,
        async () => {
          const text = await deps.userText(sessionID, inboxID);
          if (text === undefined) return;
          // If the session has started on something newer while this was being read, the loop guard's
          // history belongs to that and is left alone.
          if (deliveries.get(sessionID) === delivery) deps.startRequest(sessionID);
          await deps.persist(sessionID, { id: inboxID, text });
        },
        deps.report,
      );
    },
  };
}
