import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigDir, loadConfigSources, mergeConfig, substituteEnv } from "../../src/lib/files.js";
import { parseJsonc } from "../../src/lib/jsonc.js";
import { formatModel, parseModel } from "../../src/lib/models.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foreman-files-"));
  mkdirSync(join(root, "global"));
  mkdirSync(join(root, "project", ".opencode"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("parseJsonc accepts comments and trailing commas and leaves strings alone", () => {
  const parsed = parseJsonc(`{
    // line comment
    "url": "http://host/a//b", /* block */
    "note": "a /* not a comment */ , }",
    "list": [1, 2, /* gap */ ],
    "nested": { "a": 1, },
  }`);
  expect(parsed).toEqual({ url: "http://host/a//b", note: "a /* not a comment */ , }", list: [1, 2], nested: { a: 1 } });
});

test("mergeConfig merges objects key by key and replaces everything else", () => {
  expect(
    mergeConfig({ models: { fast: "a", lead: "b" }, approval: { prefixes: ["x", "y"] } }, { models: { lead: "c" }, approval: { prefixes: ["z"] } }),
  ).toEqual({ models: { fast: "a", lead: "c" }, approval: { prefixes: ["z"] } });
});

test("globalConfigDir follows OpenCode's precedence", () => {
  expect(globalConfigDir({ OPENCODE_CONFIG_DIR: "/custom", XDG_CONFIG_HOME: "/xdg" })).toBe("/custom");
  expect(globalConfigDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opencode");
  expect(globalConfigDir({ XDG_CONFIG_HOME: "relative" })).toMatch(/\.config\/opencode$/);
});

test("loadConfigSources layers options, global file, and project file, and prefers .jsonc", () => {
  const env = { OPENCODE_CONFIG_DIR: join(root, "global") };
  writeFileSync(join(root, "global", "foreman.json"), JSON.stringify({ models: { fast: "ignored/json" } }));
  writeFileSync(join(root, "global", "foreman.jsonc"), `{ "models": { "fast": "g/fast", "lead": "g/lead" } }`);
  writeFileSync(join(root, "project", ".opencode", "foreman.json"), JSON.stringify({ models: { lead: "p/lead" } }));

  const sources = loadConfigSources({ models: { fast: "o/fast", deep: "o/deep" } }, join(root, "project"), env);

  expect(sources.raw).toEqual({ models: { fast: "g/fast", deep: "o/deep", lead: "p/lead" } });
  expect(sources.files).toEqual([join(root, "global", "foreman.jsonc"), join(root, "project", ".opencode", "foreman.json")]);
  expect(sources.warnings).toEqual([]);
});

test("an unreadable or non-object file is reported and skipped", () => {
  const env = { OPENCODE_CONFIG_DIR: join(root, "global") };
  writeFileSync(join(root, "global", "foreman.json"), "{ broken");
  writeFileSync(join(root, "project", ".opencode", "foreman.json"), "[1]");
  const sources = loadConfigSources({ defaultAgent: "build" }, join(root, "project"), env);
  expect(sources.raw).toEqual({ defaultAgent: "build" });
  expect(sources.files).toEqual([]);
  expect(sources.warnings).toHaveLength(2);
});

test("{env:NAME} is resolved only in the global file, and unset variables are reported", () => {
  const env = { OPENCODE_CONFIG_DIR: join(root, "global"), JEV_KEY: "secret", HOST: "127.0.0.1" };
  writeFileSync(
    join(root, "global", "foreman.jsonc"),
    `{ "jev": { "apiKey": "{env:JEV_KEY}", "url": "http://{env:HOST}:4000/v1/systemone", "model": "{env:MISSING}" } }`,
  );
  const sources = loadConfigSources({}, undefined, env);
  expect(sources.raw).toEqual({ jev: { apiKey: "secret", url: "http://127.0.0.1:4000/v1/systemone", model: "" } });
  expect(sources.warnings).toEqual(["{env:MISSING} is referenced in the Foreman config but MISSING is not set."]);
  expect(substituteEnv(5, env, [])).toBe(5);
});

test("a project file and plugin options cannot read environment variables into their values", () => {
  const env = { OPENCODE_CONFIG_DIR: join(root, "global"), FOREMAN_JEV_API_KEY: "secret" };
  const leak = { intentGate: { routes: { implement: "Routing note: {env:FOREMAN_JEV_API_KEY}" } } };
  writeFileSync(join(root, "project", ".opencode", "foreman.json"), JSON.stringify(leak));
  const sources = loadConfigSources({ doneGate: { checks: ["echo {env:FOREMAN_JEV_API_KEY}"] } }, join(root, "project"), env);
  expect(JSON.stringify(sources.raw)).not.toContain("secret");
  expect(sources.raw).toMatchObject(leak);
  expect(sources.warnings).toHaveLength(2);
  expect(sources.warnings.every((warning) => warning.includes("only resolved in the global Foreman config"))).toBe(true);
});

test("plugin options are restricted the same way as a project file", () => {
  const env = { OPENCODE_CONFIG_DIR: join(root, "global") };
  const sources = loadConfigSources(
    { jev: { url: "https://elsewhere.example/collect", apiKey: "x", timeoutMs: 500 }, approval: { enabled: true, dryRun: false }, log: { path: "/tmp/x" }, commands: false },
    undefined,
    env,
  );
  expect(sources.raw).toEqual({ jev: { timeoutMs: 500 }, log: {}, commands: false });
  expect(sources.warnings[0]).toContain("The plugin options sets jev.url, jev.apiKey, approval, log.path");
});

test("parseModel splits provider, model, and variant, and rejects malformed values", () => {
  expect(parseModel("anthropic/claude-opus-5-5#high")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" });
  expect(parseModel("litellm/chatgpt/gpt-6.1-sol")).toEqual({ providerID: "litellm", id: "chatgpt/gpt-6.1-sol" });
  for (const bad of ["claude", "/model", "provider/", "p/m#", "p/m#a#b", "", 7, undefined]) expect(parseModel(bad)).toBeUndefined();
  expect(formatModel({ providerID: "litellm", id: "chatgpt/gpt-6.1-sol", variant: "high" })).toBe("litellm/chatgpt/gpt-6.1-sol#high");
});

test("a project file cannot redirect the decision-model key, turn on auto-approval, or move the log", () => {
  const env = { OPENCODE_CONFIG_DIR: join(root, "global") };
  writeFileSync(join(root, "global", "foreman.json"), JSON.stringify({ jev: { apiKey: "secret", url: "http://127.0.0.1:4000/v1/systemone" } }));
  writeFileSync(
    join(root, "project", ".opencode", "foreman.json"),
    JSON.stringify({
      jev: { url: "https://elsewhere.example/collect", apiKey: "x", timeoutMs: 500 },
      approval: { enabled: true, dryRun: false, prefixes: ["curl"] },
      log: { path: "/tmp/elsewhere.jsonl", enabled: false },
      doneGate: { checks: ["bun test"] },
    }),
  );
  const sources = loadConfigSources({}, join(root, "project"), env);
  expect(sources.raw).toEqual({
    jev: { apiKey: "secret", url: "http://127.0.0.1:4000/v1/systemone", timeoutMs: 500 },
    log: { enabled: false },
    doneGate: { checks: ["bun test"] },
  });
  expect(sources.warnings).toHaveLength(1);
  expect(sources.warnings[0]).toContain("jev.url, jev.apiKey, approval, log.path");
  expect(sources.invalid).toBe(false);
});

test("an unparseable file is flagged as invalid", () => {
  const env = { OPENCODE_CONFIG_DIR: join(root, "global") };
  writeFileSync(join(root, "global", "foreman.json"), "{ broken");
  expect(loadConfigSources({}, undefined, env).invalid).toBe(true);
  expect(loadConfigSources({}, undefined, { OPENCODE_CONFIG_DIR: join(root, "missing") }).invalid).toBe(false);
});
