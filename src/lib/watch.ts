import { existsSync, watch, type FSWatcher } from "node:fs";
import { CONFIG_FILE_NAMES } from "./files.js";

/**
 * Calls `onChange` shortly after a Foreman config file in one of the directories is created, edited, or
 * removed. Directories that do not exist yet are skipped. Returns a function that stops watching.
 */
export function watchConfig(directories: readonly string[], onChange: () => void, debounceMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  for (const directory of new Set(directories)) {
    if (!existsSync(directory)) continue;
    try {
      const watcher = watch(directory, (_event, filename) => {
        if (filename && (CONFIG_FILE_NAMES as readonly string[]).includes(String(filename))) schedule();
      });
      // A watcher that fails later (directory removed) must not take the server down with an unhandled error.
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // Watching is a convenience; without it the config still applies on the next reload.
    }
  }
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
