#!/usr/bin/env bash
# Packs the package, installs the tarball into an empty project, and imports its entry points,
# so a file missing from the published package fails here and not for a user.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$root"
bun pm pack --destination "$work" >/dev/null
tarball="$(ls "$work"/*.tgz)"
mkdir "$work/app"
cd "$work/app"
printf '{ "name": "pack-check", "private": true, "type": "module" }\n' > package.json
bun add "$tarball" >/dev/null
bun -e '
const [server, rpc] = await Promise.all([import("@nigel-dev/opencode-foreman"), import("@nigel-dev/opencode-foreman/rpc")]);
if (server.default?.id !== "foreman" || typeof server.default.setup !== "function") throw new Error("server entry is not a plugin");
if (!rpc.foremanRpc) throw new Error("rpc entry has no contract");
'
test -f node_modules/@nigel-dev/opencode-foreman/src/tui.tsx
test -f node_modules/@nigel-dev/opencode-foreman/foreman.example.jsonc
echo "packed package installs and loads"
