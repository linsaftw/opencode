#!/usr/bin/env bash
# Runs the snapshot step-cost probe N times from packages/core and reports pass/fail counts.
set -u
runs="${1:-50}"
cd "$(dirname "$0")/../packages/core" || exit 2
pass=0; fail=0
for i in $(seq 1 "$runs"); do
  if timeout 300 bun test test/snapshot-step-cost.test.ts >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); fi
done
echo "runs=$runs pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
