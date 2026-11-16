import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseJsonc } from "./jsonc.js";

export type RawConfig = Readonly<Record<string, unknown>>;

export interface ConfigSources {
  /** Merged settings: plugin options, then the global file, then the project file. Later sources win. Only the global file is trusted. */
  readonly raw: RawConfig;
  readonly files: readonly string[];
  readonly warnings: readonly string[];
  /** A config file exists but could not be read or parsed, so `raw` is missing its settings. */
  readonly invalid: boolean;
}

export const CONFIG_FILE_NAMES = ["foreman.jsonc", "foreman.json"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge key by key; anything else, arrays included, is replaced by the later source. */
export function mergeConfig(base: RawConfig, override: RawConfig): RawConfig {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(value) ? mergeConfig(existing, value) : value;
  }
  return merged;
}

const ENV_REFERENCE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replaces `{env:NAME}` in every string value. An unset variable becomes an empty string and is reported. */
export function substituteEnv(value: unknown, env: Readonly<Record<string, string | undefined>>, warnings: string[]): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REFERENCE, (_match, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) warnings.push(`{env:${name}} is referenced in the Foreman config but ${name} is not set.`);
      return resolved ?? "";
    });
  }
  if (Array.isArray(value)) return value.map((item) => substituteEnv(item, env, warnings));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteEnv(item, env, warnings)]));
  return value;
}

/** Follows OpenCode's precedence: `$OPENCODE_CONFIG_DIR`, then `$XDG_CONFIG_HOME/opencode`, then `~/.config/opencode`. */
export function globalConfigDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "opencode");
  return join(homedir(), ".config", "opencode");
}

/** The directories a Foreman config file can live in, lowest precedence first. */
export function configDirectories(
  projectDirectory: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return [globalConfigDir(env), ...(projectDirectory ? [join(projectDirectory, ".opencode")] : [])];
}

function findFile(directory: string): string | undefined {
  return CONFIG_FILE_NAMES.map((name) => join(directory, name)).find((path) => existsSync(path));
}

/**
 * Only the user's global Foreman file is trusted. A project file and plugin options can both come from a
 * repository, so neither may set where the decision-model key is sent, what shell commands are approved
 * without asking, or which file the log is written to; and neither gets environment variables substituted
 * into its values, which would let it read a secret into text that is sent to a model.
 */
function restrict(config: RawConfig, source: string, warnings: string[]): RawConfig {
  const restricted: Record<string, unknown> = { ...config };
  const ignored: string[] = [];
  if (isRecord(restricted.jev)) {
    const { url, apiKey, ...jev } = restricted.jev;
    if (url !== undefined) ignored.push("jev.url");
    if (apiKey !== undefined) ignored.push("jev.apiKey");
    restricted.jev = jev;
  }
  if (restricted.approval !== undefined) {
    ignored.push("approval");
    delete restricted.approval;
  }
  if (isRecord(restricted.log) && restricted.log.path !== undefined) {
    const { path: _path, ...log } = restricted.log;
    ignored.push("log.path");
    restricted.log = log;
  }
  if (ignored.length > 0) warnings.push(`${source} sets ${ignored.join(", ")}, which only the global Foreman config may set; ignored.`);
  if (JSON.stringify(restricted).includes("{env:")) {
    warnings.push(`${source} uses {env:NAME}, which is only resolved in the global Foreman config; left as written.`);
  }
  return restricted;
}

export function loadConfigSources(
  options: RawConfig,
  projectDirectory: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigSources {
  const globalDirectory = globalConfigDir(env);
  const files: string[] = [];
  const warnings: string[] = [];
  let raw = restrict(options, "The plugin options", warnings);
  let invalid = false;
  for (const directory of configDirectories(projectDirectory, env)) {
    const path = findFile(directory);
    if (!path || files.includes(path)) continue;
    try {
      const parsed = parseJsonc(readFileSync(path, "utf8"));
      if (!isRecord(parsed)) {
        warnings.push(`${path} is not a JSON object; ignored.`);
        invalid = true;
        continue;
      }
      const trusted = directory === globalDirectory;
      raw = mergeConfig(raw, trusted ? (substituteEnv(parsed, env, warnings) as RawConfig) : restrict(parsed, path, warnings));
      files.push(path);
    } catch (error) {
      warnings.push(`${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      invalid = true;
    }
  }
  return { raw, files, warnings, invalid };
}
