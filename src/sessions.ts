export interface SessionReader {
  get(input: { sessionID: string }): Promise<{ readonly parentID?: string | undefined }>;
  context(input: { sessionID: string }): Promise<ReadonlyArray<unknown>>;
}

/** Insertion-ordered map that evicts its oldest entry, so per-session state cannot grow without bound. */
export class BoundedMap<Key, Value> {
  private readonly entries = new Map<Key, Value>();

  constructor(private readonly limit = 500) {}

  get(key: Key): Value | undefined {
    return this.entries.get(key);
  }

  set(key: Key, value: Value): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  delete(key: Key): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Gates act on sessions the user drives. A lookup failure counts as "not root" so a gate stays out of the way. */
export function createRootCheck(reader: Pick<SessionReader, "get">): (sessionID: string) => Promise<boolean> {
  const known = new BoundedMap<string, boolean>();
  return async (sessionID) => {
    const cached = known.get(sessionID);
    if (cached !== undefined) return cached;
    try {
      const root = !(await reader.get({ sessionID })).parentID;
      known.set(sessionID, root);
      return root;
    } catch {
      return false;
    }
  };
}

export interface Turn {
  readonly userID: string;
  readonly request: string;
  readonly reply: string;
  readonly failed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** The latest user request and the assistant's final message after it. */
export function lastTurn(messages: ReadonlyArray<unknown>): Turn | undefined {
  let user: { id: string; text: string } | undefined;
  let reply = "";
  let failed = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.type === "user" && typeof message.id === "string" && typeof message.text === "string") {
      user = { id: message.id, text: message.text };
      reply = "";
      failed = false;
    } else if (message.type === "assistant" && user) {
      const body = assistantText(message);
      if (body) reply = body;
      failed = message.finish === "error" || message.error !== undefined;
    }
  }
  if (!user || !reply) return undefined;
  return { userID: user.id, request: user.text, reply, failed };
}

export function head(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

export function tail(value: string, limit: number): string {
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}
