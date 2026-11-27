#!/usr/bin/env bash
# Offline end-to-end probe of a built opencode binary: private server + scripted fake OpenAI provider, no network models.
# Usage: scripts/perf/probe-binary.sh <binary> [conversations=2]
# Starts only its own two processes (fake provider, throwaway server) on ports 49811/49812 and stops those pids.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="${1:?binary path}"
COUNT="${2:-2}"
WORK="$(mktemp -d /tmp/claude-1000/probe-binary.XXXXXX)"
PROVIDER_PORT=49811
SERVER_PORT=49812
PASSWORD="probe-$$"
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${PROVIDER_PID:-}" ]] && kill "$PROVIDER_PID" 2>/dev/null || true
}
trap cleanup EXIT
cd "$ROOT"
PORT=$PROVIDER_PORT bun scripts/perf/fake-openai-server.ts >"$WORK/provider.log" 2>&1 &
PROVIDER_PID=$!
export XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache"
export OPENCODE_SERVER_PASSWORD="$PASSWORD"
export OPENCODE_CONFIG_CONTENT="{\"provider\":{\"openai\":{\"settings\":{\"baseURL\":\"http://127.0.0.1:$PROVIDER_PORT/v1\",\"apiKey\":\"x\"}}}}"
"$BIN" serve --port "$SERVER_PORT" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 240); do
  code="$(curl -s -o /dev/null -m2 -w '%{http_code}' -u "opencode:$PASSWORD" "http://127.0.0.1:$SERVER_PORT/api/info" || true)"
  [[ "$code" == 200 ]] && break
  sleep 0.25
done
[[ "${code:-}" == 200 ]] || { echo "PROBE-FAIL: server never answered 200 (see $WORK/server.log)"; exit 1; }
echo "server up: /api/info 200, version $("$BIN" --version)"
bun scripts/perf/drive-conversations.ts "http://127.0.0.1:$SERVER_PORT" "$COUNT" | tail -3
echo "PROBE-OK ($WORK)"
