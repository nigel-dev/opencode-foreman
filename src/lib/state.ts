import { head } from "./sessions.js";

/** What Foreman remembers about one session. Kept in plugin storage so it survives reloads and compaction. */
export interface SessionRecord {
  /** The latest user request, recorded when it was submitted. */
  readonly request?: { readonly id: string; readonly text: string };
  /** Done-gate continuations sent for a request. */
  readonly nudges?: { readonly requestID: string; readonly count: number };
  /** The request whose subagent report has already been sent back once. */
  readonly revised?: string;
  /** Supervision is paused for this session and its subagents. */
  readonly paused?: boolean;
}

export interface StateStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SessionState {
  read(sessionID: string): Promise<SessionRecord>;
  update(sessionID: string, patch: Partial<SessionRecord>): Promise<SessionRecord>;
  remove(sessionID: string): Promise<void>;
}

const key = (sessionID: string) => `session/${sessionID}`;
const REQUEST_LIMIT = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRecord(value: unknown): SessionRecord {
  if (!isRecord(value)) return {};
  const { request, nudges, revised, paused } = value;
  return {
    ...(isRecord(request) && typeof request.id === "string" && typeof request.text === "string" ? { request: { id: request.id, text: request.text } } : {}),
    ...(isRecord(nudges) && typeof nudges.requestID === "string" && typeof nudges.count === "number"
      ? { nudges: { requestID: nudges.requestID, count: nudges.count } }
      : {}),
    ...(typeof revised === "string" ? { revised } : {}),
    ...(paused === true ? { paused: true } : {}),
  };
}

/**
 * Reads storage on every call and keeps nothing in memory: several plugin instances share the storage,
 * and a cache in one would go stale when another writes.
 */
export function createSessionState(storage: StateStorage): SessionState {
  // Updates are read-modify-write, so they run one at a time within this instance.
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (sessionID: string) => parseRecord(await storage.get(key(sessionID)));

  return {
    read,
    update(sessionID, patch) {
      const next = queue.then(async () => {
        const merged: SessionRecord = { ...(await read(sessionID)), ...patch };
        const record: SessionRecord = merged.request ? { ...merged, request: { id: merged.request.id, text: head(merged.request.text, REQUEST_LIMIT) } } : merged;
        const { paused, ...rest } = record;
        await storage.set(key(sessionID), { ...rest, ...(paused ? { paused: true } : {}) });
        return record;
      });
      queue = next.catch(() => undefined);
      return next;
    },
    remove: (sessionID) => storage.remove(key(sessionID)),
  };
}

export interface TurnIdentity {
  readonly requestID: string;
  readonly request: string;
}

/** The request a turn answers: the user message in the window, or the recorded one after compaction removed it. */
export function identifyTurn(turn: { readonly userID: string | undefined; readonly request: string | undefined }, record: SessionRecord): TurnIdentity | undefined {
  if (turn.userID !== undefined && turn.request !== undefined) return { requestID: turn.userID, request: turn.request };
  return record.request ? { requestID: record.request.id, request: record.request.text } : undefined;
}
