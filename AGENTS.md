# AGENTS.md

Guide for coding agents working on `opencode-foreman`.

> NOTE! Never replace the string opencode with claude or claude code unless explicitly asked to.

## Mission

- Keep changes small, safe, and shippable.
- Match existing repository patterns (TypeScript + Bun + one-gate-per-file design).
- Prefer deterministic behavior over clever behavior.

## Fast Project Map

- `src/index.ts` - plugin entry point, reads config and registers hooks.
- `src/agents/` - bundled agent definitions and the transform that registers them.
- `src/hooks/` - one file per gate (`done`, `intent`, `approval`).
- `src/lib/` - shared logic (config, decision-model client, session helpers).
- `tests/` - Bun test suite, mirroring `src/`.
- `scripts/smoke.ts` - live scenario checks against the decision model.

## Working Rules

1. Implement exactly what was requested; do not add extra features.
2. For bug fixes: make minimal edits, avoid broad refactors.
3. Never use `as any`, `@ts-ignore`, or silent catch blocks. A catch that deliberately fails open says why in a comment.
4. Keep file ownership boundaries intact (gate logic in `src/hooks`, shared logic in `src/lib`).
5. Every gate must do nothing when the decision model is unavailable.
6. Do not add runtime dependencies. `@opencode/plugin` is a type-only import.
7. Do not commit unless explicitly asked.

## Build and Verify

Run these before marking work complete:

```bash
bun run typecheck
bun run lint
bun run build
bun run test
```

When a change touches a gate's questions or thresholds, also run `bun run smoke` with `FOREMAN_JEV_API_KEY` set; unit tests cannot show how the model answers.

OpenCode loads `dist/index.js`. Rebuild before testing in a real host, and test in a throwaway project rather than the global config.

## CI & GitHub Workflows

- **CI** (`.github/workflows/ci.yml`) — Runs build, typecheck, lint, and tests on PRs and pushes to `main`.
- **Conventional Commits** (`.github/workflows/conventional-commits.yml`) — Validates PR titles and commit subjects on `main`.
- **CodeQL** (`.github/workflows/codeql.yml`) — Static analysis for TypeScript; runs on PRs, pushes to `main`, and weekly.
- **Publish** (`.github/workflows/publish.yml`) — semantic-release to npm on `main`.
- **Renovate** (`renovate.json`) — Automated dependency updates. Uses `chore(deps):` and `ci(deps):` commit prefixes.
