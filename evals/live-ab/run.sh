#!/usr/bin/env bash
# Live A/B eval runner: headless `claude -p` sessions against a tree's REAL MCP server
# (stdio, spawned per session). Complements the stubbed Layer B suite (evals/run.ts):
# Layer B grades against a stub chain with an SDK loop; this harness grades the actual
# advertised wire surface end-to-end, and can point at TWO checkouts (e.g. a worktree at
# an older commit) to A/B a schema change. See evals/live-ab/README.md.
#
# Usage: run.sh <label> <treeRoot> <model> [taskId]
#   label    output bucket name under evals/live-ab/runs/<label>/
#   treeRoot repo checkout whose MCP server to run (repo root or a git worktree)
#   model    e.g. claude-haiku-4-5 (sensitive tier) or claude-sonnet-5
set -u
LABEL="$1"; TREE="$2"; MODEL="$3"; ONLY="${4:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
BUN="$(command -v bun || (cd "$DIR/../.." && mise which bun))"
OUT="$DIR/runs/$LABEL"
mkdir -p "$OUT"

cat > "$OUT/mcp.json" <<EOF
{"mcpServers":{"cork":{"command":"$BUN","args":["$TREE/packages/mcp/src/bin.ts"],"env":{"CORK_CONFIG_NO_FETCH":"1"}}}}
EOF

ids=$(python3 -c "import json;print('\n'.join(t['id'] for t in json.load(open('$DIR/tasks.json'))))")
for id in $ids; do
  [ -n "$ONLY" ] && [ "$id" != "$ONLY" ] && continue
  [ -s "$OUT/$id.jsonl" ] && { echo "skip $id (exists)"; continue; }
  prompt=$(python3 -c "import json;print([t['prompt'] for t in json.load(open('$DIR/tasks.json')) if t['id']=='$id'][0])")
  echo ">>> $LABEL/$id"
  timeout 420 claude -p "$prompt" \
    --model "$MODEL" \
    --mcp-config "$OUT/mcp.json" --strict-mcp-config \
    --allowedTools "mcp__cork__*" \
    --disallowedTools "Bash,Read,Glob,Grep,Write,Edit,WebSearch,WebFetch,Task,TodoWrite,NotebookEdit,Skill" \
    --max-turns 8 \
    --output-format stream-json --verbose \
    > "$OUT/$id.jsonl" 2> "$OUT/$id.err" || echo "  (exit $? for $id)"
done
echo "done: $LABEL"
