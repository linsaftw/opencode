#!/usr/bin/env bash
# CPU of `run --standalone --format json --model none/none "reply OK"` from source (parent CLI + serve child tree).
# Usage: scripts/perf/run-standalone-cpu.sh <runs=3> <work-dir> [profile=0|1] [idle=0|1] [shared-store=0|1]
# shared-store=1 reuses one XDG data/cache/config tree for all runs (warm model catalog); default is a fresh tree per run.
# idle=1 starts only `serve --stdio --port 0` and stops its own pid (boot baseline for cpuprofile-count-diff.ts).
# profile=1 writes BUN_OPTIONS --cpu-prof files into <work-dir>/run-N/prof for parent and child.
# Every run gets a fresh XDG tree with an EMPTY config. No real model: --model none/none, proxies closed.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNS="${1:-3}"
WORK="${2:?work dir}"
PROF="${3:-0}"
IDLE="${4:-0}"
SHARED="${5:-0}"
TICKS="$(getconf CLK_TCK)"
PROJ="$WORK/project"
mkdir -p "$PROJ"
[[ -d "$PROJ/.git" ]] || git -C "$PROJ" init -q
for run in $(seq 1 "$RUNS"); do
  base="$WORK/run-$run"
  rm -rf "$base"; rm -f "$base/spawns.log"
  store="$base"; [[ "$SHARED" == 1 ]] && store="$WORK/shared"
  mkdir -p "$store/data" "$store/state" "$store/config" "$store/cache" "$store/home" "$base/prof" "$base/shim"
  for tool in git rg; do
    real="$(command -v "$tool")"
    printf '#!/usr/bin/env bash\necho "%s $*" >> "$OPENCODE_SHIM_LOG"\nexec "%s" "$@"\n' "$tool" "$real" >"$base/shim/$tool"
    chmod +x "$base/shim/$tool"
  done
  shim_env=()
  [[ "$PROF" == 1 ]] && shim_env=(BUN_OPTIONS="--cpu-prof-dir=$base/prof --cpu-prof")
  envs=(HOME="$store/home" XDG_DATA_HOME="$store/data" XDG_STATE_HOME="$store/state" \
    XDG_CONFIG_HOME="$store/config" XDG_CACHE_HOME="$store/cache" \
    HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
    PATH="$base/shim:$PATH" OPENCODE_SHIM_LOG="$base/spawns.log")
  if [[ "$IDLE" == 1 ]]; then
    start=$(date +%s%N)
    coproc SRV {
      exec env "${envs[@]}" "${shim_env[@]}" bun "$ROOT/packages/cli/src/index.ts" serve --stdio --port 0 2>"$base/stderr.log"
    }
    read -r -u "${SRV[0]}" ready
    end=$(date +%s%N)
    stat=$(cut -d' ' -f14,15 "/proc/$SRV_PID/stat")
    ticks=$(( ${stat% *} + ${stat#* } ))
    echo "run=$run mode=idle ready_ms=$(( (end - start) / 1000000 )) cpu_s=$(echo "scale=2; $ticks / $TICKS" | bc)"
    kill -TERM "$SRV_PID" 2>/dev/null || true
    wait "$SRV_PID" 2>/dev/null || true
    continue
  fi
  # /usr/bin/time reports the waited-for tree (parent + serve child) user+sys in its own rusage line.
  ( cd "$PROJ" && /usr/bin/time -f "tree_user=%U tree_sys=%S wall=%e" -o "$base/time.txt" \
      env "${envs[@]}" "${shim_env[@]}" bun "$ROOT/packages/cli/src/index.ts" run --standalone --format json --model none/none "reply OK" \
      >"$base/out.jsonl" 2>"$base/stderr.log" ) || true
  echo "run=$run mode=run $(cat "$base/time.txt" | tail -1) spawns=$(wc -l <"$base/spawns.log" 2>/dev/null || echo 0)"
done
