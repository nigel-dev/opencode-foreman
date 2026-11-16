export interface SessionReader {
  get(input: { sessionID: string }): Promise<{
    readonly parentID?: string | undefined;
    readonly location?: { readonly directory?: string | undefined } | undefined;
  }>;
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

export interface SessionFacts {
  /** `unknown` when the lookup failed, so a gate can stay out of the way. */
  readonly kind: "root" | "child" | "unknown";
  readonly parentID: string | undefined;
  readonly directory: string | undefined;
}

/** Looked up fresh each time: a session can move to another directory, and gates run rarely. */
export function createSessionLookup(reader: Pick<SessionReader, "get">): (sessionID: string) => Promise<SessionFacts> {
  return async (sessionID) => {
    try {
      const session = await reader.get({ sessionID });
      return { kind: session.parentID ? "child" : "root", parentID: session.parentID, directory: session.location?.directory };
    } catch {
      return { kind: "unknown", parentID: undefined, directory: undefined };
    }
  };
}

export interface Turn {
  /** The latest user message still in the context window; absent once compaction has replaced it. */
  readonly userID: string | undefined;
  readonly request: string | undefined;
  /** The assistant's final text after that message; empty when it said nothing. */
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

/**
 * The assistant's final message and, when it is still in the window, the user request before it.
 * `session.context` returns the active window, which starts at the latest compaction, so a long turn
 * can have assistant messages with no user message in front of them.
 */
export function lastTurn(messages: ReadonlyArray<unknown>): Turn | undefined {
  let user: { id: string; text: string } | undefined;
  let reply = "";
  let failed = false;
  let answered = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.type === "user" && typeof message.id === "string" && typeof message.text === "string") {
      user = { id: message.id, text: message.text };
      reply = "";
      failed = false;
      answered = false;
    } else if (message.type === "assistant") {
      answered = true;
      const body = assistantText(message);
      if (body) reply = body;
      failed = message.finish === "error" || message.error !== undefined;
    }
  }
  if (!answered) return undefined;
  return { userID: user?.id, request: user?.text, reply, failed };
}

export function head(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

export function tail(value: string, limit: number): string {
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}
