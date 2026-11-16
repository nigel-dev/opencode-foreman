import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchConfig } from "../../src/lib/watch.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foreman-watch-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("fires once for a burst of edits to a Foreman config file and ignores other files", async () => {
  let calls = 0;
  const stop = watchConfig([root, join(root, "missing")], () => void calls++, 100);
  await wait(50);
  writeFileSync(join(root, "opencode.json"), "{}");
  await wait(300);
  expect(calls).toBe(0);

  writeFileSync(join(root, "foreman.jsonc"), "{}");
  writeFileSync(join(root, "foreman.jsonc"), `{ "commands": false }`);
  await wait(500);
  expect(calls).toBe(1);

  stop();
  writeFileSync(join(root, "foreman.json"), "{}");
  await wait(300);
  expect(calls).toBe(1);
});
