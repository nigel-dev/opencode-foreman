# Contributing to Foreman

Thank you for your interest in contributing!

## Prerequisites
- [Bun](https://bun.sh)
- [git](https://git-scm.com)
- [OpenCode](https://opencode.ai) 2.3.0 or newer, for local testing

## Development Setup
1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   bun install
   ```
3. Build the project:
   ```bash
   bun run build
   ```
4. Run the checks:
   ```bash
   bun run typecheck
   bun run lint
   bun run test
   ```

## Local Testing
To test your changes locally with OpenCode:
1. Add your local repository path to `plugins` in an `opencode.json`. A throwaway project with its own `.opencode/opencode.json` keeps the plugin out of your real sessions.
2. Use `bun run build` to update the `dist/` folder after changes. OpenCode loads `dist/index.js`, not the TypeScript source.
3. Confirm the plugin is listed as `active`:
   ```bash
   opencode api get '/api/plugin?location[directory]=/path/to/project'
   ```

To check the gates' questions against the real decision model:

```bash
FOREMAN_JEV_API_KEY=... bun run smoke
```

## Architecture Overview

```
src/
  index.ts              # Plugin entry point — reads config, registers agents and hooks
  agents/               # Bundled agent roster
    types.ts            # AgentDefinition, tiers, shared permission sets
    shared.ts           # Prompt sections reused across agents
    orchestrator.ts, planner.ts, deep.ts, workers.ts, specialists.ts
    index.ts            # ROSTER, built-in agent tiers, roster-aware routing hints
    register.ts         # Agent transform: applies definitions, tier models, overrides
  commands.ts           # Slash commands: /plan, /start-work, /stop-work, /review-work, /handoff
  hooks/                # One file per gate
    done.ts             # session experimental.idle — nudges unfinished or unverified work
    intent.ts           # session prompt + context — classifies requests, injects a routing hint
    approval.ts         # permission evaluate — screens and scores ask-level shell commands
    report.ts           # session experimental.idle (child sessions) — sends weak subagent reports back once
    loop.ts             # tool execute.before — blocks identical consecutive tool calls
  lib/                  # Shared internal logic
    config.ts           # Options and environment resolution, defaults
    files.ts            # foreman.json(c) discovery and layered merge
    jsonc.ts            # Comment and trailing-comma stripping
    models.ts           # provider/model#variant parsing
    checks.ts           # Runs the configured project check commands
    plans.ts            # Plan lookup, checkbox progress, per-session active plan
    jev.ts              # Decision-model client (System One request and response parsing)
    sessions.ts         # Root-session check, last-turn extraction, bounded per-session state
tests/                  # Bun test suite, mirroring src/
scripts/
  smoke.ts              # Live scenario checks against the decision model
```

### Key Design Decisions

- **One gate per file** in `src/hooks/`. Each exports its questions, a pure decision function (`judge`, `classify`, `screen`), and a factory that takes its dependencies, so it is testable without an OpenCode host.
- **Fail open.** The decision client resolves to `undefined` on any failure, and every gate treats that as "do nothing". An outage must never block a session.
- **No runtime dependencies.** `@opencode/plugin` is imported for types only; the plugin object is checked with `satisfies`.
- **Root sessions only** for the done and intent gates. Subagent child sessions are left alone.
- **The approval filter is not a security boundary.** It narrows what is sent for scoring. Changes that widen it need tests for the bypass they could open.

## Pull Request Process
1. Fork the repo and create a branch from `main`.
2. Implement your changes, with tests.
3. Ensure the build, type check, lint, and tests pass.
4. Use a [Conventional Commits](https://www.conventionalcommits.org) title; releases are cut from commit types by semantic-release.
