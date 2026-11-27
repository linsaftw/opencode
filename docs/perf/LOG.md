# CPU composition log

## 2026-11-27 baseline (read-only sampling, no processes touched)
- Shared service (pid 106564, 17h): ~0.9% avg CPU, 913 MB RSS. Of its CPU time ~68% is the mimalloc
  scavenger thread (`mi-scav`), under heavy system memory pressure (30 GB swap, 35% iowait).
- Real cost: 49 live `opencode serve --stdio --port 0` backends (~400 MB each, ~15 CPU-s startup each).
  All are children of `opencode run --standalone ...` launched by claude-opencode-mcp per delegated task.
- Fix landed (claude-opencode-mcp 9588d09): runs and pool workers attach to the shared service;
  agent profiles are materialized in the global agents dir (service hot-loads them).
  Verified: deepseek-coder run on the shared service, serve --stdio count 49 -> 49 (no new backend).
- Next: purge delay / allocator settings for the service, startup cost of `serve --stdio`, per-token projection share.

## 2026-11-27 batch 1 (native coders; each fix carries a probe)
- Landed: bus fast path + Bun.hash dedupe (31904f2468), decoded-history row cache (30210cabad),
  no-op assistant update skip + stored-JSON reuse (904298dd37).
- Measured by probe only (behavior identical); long-session before/after CPU share still owed.
- Declined: dropping the durable-event id pre-check (changes the error type); delta coalescing
  (protocol change, needs a decision); skipping the end-of-step snapshot scan (see below).
- OPEN UNIT (correctness + perf): snapshot capture race. Repro: docs/perf/snapshot-racy-probe.ts.txt
  (move to packages/core/test/snapshot-step-cost.test.ts). A same-size edit ("one" -> "two") sometimes
  yields end tree == start tree (about 3 of 15 runs). Suspect the racy-timestamp window in git.ts
  attemptCapture / withTemporaryIndex / lastCaptures fingerprint reuse. Measured git calls per step:
  14 (no-op, two captures), 16 (edit). Fix the race first, then a safe end-capture skip is possible.
- Queued: idle-polling items (models.dev ETag, per-location config reload, local provider backoff).

## 2026-11-27 batch 2 (idle polling; probes: models-dev-conditional, provider-local-backoff, provider-opencode)
- Landed: models.dev refresh hourly with ETag/304; Console re-check 15 min; local provider probes back off to 5 min
  (<=14 probes/h vs 120); service registration poll 30 s.
- OPEN UNITS (reverted for lack of a cheap probe, re-land with an observable counter):
  per-location config wellknown loop doing a full reload() when unchanged (config.ts ~L361-378);
  integration.ts 30 s scrub loops that wake with empty maps (arm one timer to earliest expiry).
  Add a test-only counter or event hook, then re-apply. Also still open: SSE heartbeat per client,
  recursive watchers without ignore (config/plugin/skill.ts, plugin/module.ts), 1-min sweeps.

## 2026-11-27 merge + install (binary swapped on disk, service swap pending)
- Upstream sync merged (0cccf8aa86): 496 core tests, typecheck clean in core/cli/server; snapshot racy loop 50/50.
  Superseded by upstream and dropped: projector stored-JSON reuse, fixed 15 min Console re-check.
- Binary built and installed to ~/.local/bin/opencode (v2.4.1). No backups kept (user order).
- Service swap blocked: `service status` reports stopped while pid 1415877 serves 49374 (health 200), so
  `service restart` tries to start a second copy and exits; clients retry-spawn short-lived `serve --service`.
  Needs the old pid to exit once (user decision pending).
- Live composition, 5 s per-thread ticks (service under ~45 workers, ~45% of one core):
  main JS thread 223 (80%), JIT 28 (10%), HTTP client 12, heap helper 10, mi-scav 5 (2%).
  mi-scav is no longer a meaningful share under load. NEXT TARGET: main-thread JS (profile with --cpu-prof on a throwaway instance).
