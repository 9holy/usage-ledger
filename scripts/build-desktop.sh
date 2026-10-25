#!/usr/bin/env bash
# Unsigned local Windows build from Git Bash. Requires Node.js and Rust on PATH.
# Usage: bash scripts/build-desktop.sh
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
NODE="${NODE:-node}"

echo "=== [1/3] vue-tsc -b ==="
"$NODE" node_modules/vue-tsc/bin/vue-tsc.js -b

echo "=== [2/3] vite build --mode desktop ==="
"$NODE" node_modules/vite/bin/vite.js build --mode desktop

echo "=== [3/3] tauri build ==="
# The frontend is already built. Local builds do not require an updater signing key.
"$NODE" node_modules/@tauri-apps/cli/tauri.js build --config '{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'
