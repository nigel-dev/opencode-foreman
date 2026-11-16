import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseJsonc } from "./jsonc.js";

export type RawConfig = Readonly<Record<string, unknown>>;

export interface ConfigSources {
  /** Merged settings: plugin options, then the global file, then the project file. Later sources win. */
  readonly raw: RawConfig;
  readonly files: readonly string[];
  readonly warnings: readonly string[];
}

const FILE_NAMES = ["foreman.jsonc", "foreman.json"];

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

function findFile(directory: string): string | undefined {
  return FILE_NAMES.map((name) => join(directory, name)).find((path) => existsSync(path));
}

export function loadConfigSources(
  options: RawConfig,
  projectDirectory: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigSources {
  const candidates = [findFile(globalConfigDir(env)), projectDirectory && findFile(join(projectDirectory, ".opencode"))];
  const files: string[] = [];
  const warnings: string[] = [];
  let raw = options;
  for (const path of candidates) {
    if (!path || files.includes(path)) continue;
    try {
      const parsed = parseJsonc(readFileSync(path, "utf8"));
      if (!isRecord(parsed)) {
        warnings.push(`${path} is not a JSON object; ignored.`);
        continue;
      }
      raw = mergeConfig(raw, parsed);
      files.push(path);
    } catch (error) {
      warnings.push(`${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { raw: substituteEnv(raw, env, warnings) as RawConfig, files, warnings };
}
