#!/bin/sh
set -eu
# Convenience runner for this Mac if npm/Node are absent from terminal PATH.
# The shared application and all project data remain portable.
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if command -v node >/dev/null 2>&1; then
  task_node=$(command -v node)
else
  task_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [ ! -x "$task_node" ]; then
  echo 'Node.js not found. Install Node.js 20.19+ with npm, then run npm ci.' >&2
  exit 1
fi
cd "$task_root"
if [ ! -d node_modules/tsx ]; then
  echo 'Dependencies missing. Run npm ci in platform/ first.' >&2
  exit 1
fi
case "${1:-}" in
  diagnose-text) shift; exec "$task_node" --import tsx "$task_root/scripts/diagnose-text.ts" "$@" ;;
  benchmark) shift; exec "$task_node" --import tsx "$task_root/scripts/benchmark.ts" "$@" ;;
  benchmark-report) shift; exec "$task_node" --import tsx "$task_root/scripts/benchmark-report.ts" "$@" ;;
  benchmark-replay) shift; exec "$task_node" --import tsx "$task_root/scripts/replay-agent-run.ts" "$@" ;;
esac
if [ "${1:-}" = "dev" ]; then
  "$task_node" "$task_root/scripts/build-ui.mjs"
fi
exec "$task_node" --import tsx "$task_root/apps/scene-validator/src/cli.ts" "$@"
