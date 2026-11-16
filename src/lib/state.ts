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
  update(sessionID: string, patch: Partial<SessionRecord>): Promise<void>;
  remove(sessionID: string): Promise<void>;
}

const FIELDS = ["request", "nudges", "revised", "paused"] as const;
const key = (sessionID: string, field: (typeof FIELDS)[number]) => `session/${sessionID}/${field}`;
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
 * Each field has its own storage key and is written whole, so there is no read-modify-write: two plugin
 * instances updating different fields of one session cannot overwrite each other. Nothing is cached,
 * because instances share the storage.
 */
export function createSessionState(storage: StateStorage): SessionState {
  return {
    async read(sessionID) {
      const [request, nudges, revised, paused] = await Promise.all(FIELDS.map((field) => storage.get(key(sessionID, field))));
      return parseRecord({ request, nudges, revised: isRecord(revised) ? revised.requestID : undefined, paused: isRecord(paused) ? paused.paused : undefined });
    },
    async update(sessionID, patch) {
      const writes: Promise<void>[] = [];
      if (patch.request) writes.push(storage.set(key(sessionID, "request"), { id: patch.request.id, text: head(patch.request.text, REQUEST_LIMIT) }));
      if (patch.nudges) writes.push(storage.set(key(sessionID, "nudges"), { ...patch.nudges }));
      if (patch.revised !== undefined) writes.push(storage.set(key(sessionID, "revised"), { requestID: patch.revised }));
      if (patch.paused === true) writes.push(storage.set(key(sessionID, "paused"), { paused: true }));
      if (patch.paused === false) writes.push(storage.remove(key(sessionID, "paused")));
      await Promise.all(writes);
    },
    async remove(sessionID) {
      await Promise.all(FIELDS.map((field) => storage.remove(key(sessionID, field))));
    },
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
