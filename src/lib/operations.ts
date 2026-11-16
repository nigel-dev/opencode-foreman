/** One gate run for a session. Cancelled when the user stops the session, sends a new request, or the plugin unloads. */
export interface Operation {
  readonly signal: AbortSignal;
  /** False once cancelled; checked before anything is sent into the session. */
  live(): boolean;
  end(): void;
}

export interface Operations {
  /** Starts an operation for a session, cancelling any earlier one that is still running for it. */
  begin(sessionID: string): Operation;
  cancel(sessionID: string): boolean;
  cancelAll(): void;
}

export function createOperations(): Operations {
  const running = new Map<string, AbortController>();

  const cancel = (sessionID: string) => {
    const controller = running.get(sessionID);
    if (!controller) return false;
    running.delete(sessionID);
    controller.abort();
    return true;
  };

  return {
    begin(sessionID) {
      cancel(sessionID);
      const controller = new AbortController();
      running.set(sessionID, controller);
      return {
        signal: controller.signal,
        live: () => !controller.signal.aborted,
        end: () => {
          if (running.get(sessionID) === controller) running.delete(sessionID);
        },
      };
    },
    cancel,
    cancelAll() {
      for (const sessionID of [...running.keys()]) cancel(sessionID);
    },
  };
}
