#!/usr/bin/env bash
# Cold boot CPU of `serve --stdio --port 0` from source, measured on the bun process (utime+stime from /proc).
# Usage: scripts/perf/serve-boot-cpu.sh <runs=5> <fresh|shared-cache> <work-dir>
# Every run gets fresh XDG data/state/config; `shared-cache` reuses one XDG_CACHE_HOME across runs, `fresh` makes a new one.
# Blocks on the stdio ready line ({"url"}) instead of polling, then stops only its own pid.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNS="${1:-5}"
MODE="${2:-fresh}"
WORK="${3:?work dir}"
mkdir -p "$WORK"
SHARED_CACHE="$WORK/cache-shared"
TICKS="$(getconf CLK_TCK)"
cd "$ROOT/packages/cli"
for run in $(seq 1 "$RUNS"); do
  base="$WORK/run-$run-$$"
  cache="$base/cache"
  [[ "$MODE" == shared-cache ]] && cache="$SHARED_CACHE"
  mkdir -p "$base/data" "$base/state" "$base/config" "$cache" "$base/home"
  coproc SRV {
    exec env HOME="$base/home" XDG_DATA_HOME="$base/data" XDG_STATE_HOME="$base/state" \
      XDG_CONFIG_HOME="$base/config" XDG_CACHE_HOME="$cache" \
      HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
      bun src/index.ts serve --stdio --port 0 2>"$base/stderr.log"
  }
  read -r -u "${SRV[0]}" ready
  stat=$(cut -d' ' -f14,15 "/proc/$SRV_PID/stat")
  ticks=$(( ${stat% *} + ${stat#* } ))
  echo "run=$run ready=$ready cpu_s=$(echo "scale=2; $ticks / $TICKS" | bc)"
  kill -TERM "$SRV_PID" 2>/dev/null || true
  wait "$SRV_PID" 2>/dev/null || true
done
