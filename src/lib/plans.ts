import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLAN_DIRECTORY } from "../agents/types.js";
import { BoundedMap } from "./sessions.js";

export interface PlanProgress {
  readonly open: number;
  readonly done: number;
}

const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/gm;
const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Counts Markdown task checkboxes; a plan with none reports zero open tasks and is never treated as unfinished. */
export function planProgress(content: string): PlanProgress {
  let open = 0;
  let done = 0;
  for (const match of content.matchAll(CHECKBOX)) {
    if (match[1] === " ") open++;
    else done++;
  }
  return { open, done };
}

export function listPlans(directory: string): string[] {
  const root = join(directory, PLAN_DIRECTORY);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({ file, modified: statSync(join(root, file)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified)
    .map((entry) => entry.file.slice(0, -".md".length));
}

export type PlanLookup =
  | { readonly found: true; readonly name: string; readonly path: string }
  | { readonly found: false; readonly reason: string };

/** With no name, the only plan is chosen; several plans need a name. Names cannot leave the plan directory. */
export function resolvePlan(directory: string, requested: string): PlanLookup {
  const available = listPlans(directory);
  const name = requested.trim().replace(/\.md$/, "");
  if (name === "") {
    if (available.length === 1 && available[0]) return { found: true, name: available[0], path: join(directory, PLAN_DIRECTORY, `${available[0]}.md`) };
    return {
      found: false,
      reason: available.length === 0 ? `There are no plans in ${PLAN_DIRECTORY}/.` : `Several plans exist; name one of: ${available.join(", ")}.`,
    };
  }
  if (!PLAN_NAME.test(name) || !available.includes(name)) {
    return {
      found: false,
      reason: `No plan named "${name}" in ${PLAN_DIRECTORY}/.${available.length > 0 ? ` Available: ${available.join(", ")}.` : ""}`,
    };
  }
  return { found: true, name, path: join(directory, PLAN_DIRECTORY, `${name}.md`) };
}

export interface ActivePlan {
  readonly path: string;
  readonly content: string;
  readonly progress: PlanProgress;
}

export interface PlanStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PlanStore {
  activate(sessionID: string, path: string): Promise<void>;
  clear(sessionID: string): Promise<string | undefined>;
  /** The session's active plan, read fresh from disk. A plan whose file is gone is dropped. */
  active(sessionID: string): Promise<ActivePlan | undefined>;
}

const key = (sessionID: string) => `plan/${sessionID}`;

export function createPlanStore(storage: PlanStorage): PlanStore {
  // `null` records "looked up, none", so sessions without a plan do not hit storage on every model request.
  const cache = new BoundedMap<string, string | null>();

  const pathFor = async (sessionID: string): Promise<string | undefined> => {
    const cached = cache.get(sessionID);
    if (cached !== undefined) return cached ?? undefined;
    const stored = await storage.get(key(sessionID));
    const path = typeof stored === "string" && stored !== "" ? stored : null;
    cache.set(sessionID, path);
    return path ?? undefined;
  };

  const clear = async (sessionID: string) => {
    const path = await pathFor(sessionID);
    cache.set(sessionID, null);
    if (path) await storage.remove(key(sessionID));
    return path;
  };

  return {
    async activate(sessionID, path) {
      cache.set(sessionID, path);
      await storage.set(key(sessionID), path);
    },
    clear,
    async active(sessionID) {
      const path = await pathFor(sessionID);
      if (!path) return undefined;
      if (!existsSync(path)) {
        await clear(sessionID);
        return undefined;
      }
      const content = readFileSync(path, "utf8");
      return { path, content, progress: planProgress(content) };
    },
  };
}

const INJECT_LIMIT = 12_000;

export function renderActivePlan(plan: ActivePlan): string {
  const { open, done } = plan.progress;
  const body = plan.content.length <= INJECT_LIMIT ? plan.content : `${plan.content.slice(0, INJECT_LIMIT)}\n… (truncated; read the file for the rest)`;
  return [
    "## Foreman active plan",
    "",
    `This session is carrying out the plan at \`${plan.path}\`. ${open} of ${open + done} tasks are still open.`,
    "Work through the open tasks in order. When a task is done and verified, tick its checkbox in the plan file (`- [x]`). If the plan turns out to be wrong, stop and tell the user.",
    "",
    "<plan>",
    body,
    "</plan>",
  ].join("\n");
}
