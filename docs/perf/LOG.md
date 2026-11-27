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

## 2026-11-27 throwaway profile (main JS thread, no code change)
- Method: `bun --cpu-prof` on a throwaway `serve --port <random>` from source, isolated XDG/HOME under /tmp/claude-1000/prof.
  Driven ~10 s: 3x session.create, session.list, session.active/info/get x8, SSE /api/event attached 10 s. No provider
  (no offline scripted fake reachable from the CLI), so no prompt/stream/tool calls. Profile covers ~35 s incl. startup.
- Tool: scripts/perf/cpuprofile-shares.ts (self-time top N, subsystem heuristic, STACK=1 prints ancestor chain).
- Composition (share of sampled main-thread time): Effect runtime frames ~44% (effect.js evaluate/orDie/runLoop,
  Scheduler drain, setImmediate ~5%); video-generation.ts:288 tick ~14% (suspect: 5 s poll cannot cost this much;
  attribution unverified); SSE/stream writes ~8% (readable resume, writeHeadAndEnd); sqlite ~5% (SqliteClient.js:118);
  node:vm ~3%; HTTP ~1%; JSON, history, bus, projector each <0.2%; GC not visible as a separate node.
- Caveat: profile shows ~0 idle samples, so the denominator is sampled time, not wall time. Not representative of a
  real conversation.
- Candidates, none fixed (unverified or not safely isolated): (1) packages/core/src/video-generation.ts:288 tick,
  verify by counting tick entries; (2) packages/core/src/video-generation.ts:278 rows loop; (3)
  node_modules/@effect/sql-sqlite-bun/dist/SqliteClient.js:118.
- Stray: an unrelated server already on port 44870 answered 401 to unauthenticated POSTs; left untouched.
- video-generation tick (kv.scan per idle tick): before 12 scans per simulated minute (one full paged scan per 5 s tick with no running job; test/video-generation-idle.test.ts, measured on HEAD). Layer is makeGlobalNode, so one instance per process, not per Location or session.
- After: 1 scan per simulated minute while idle (a one-row json_extract probe every 5 s, full scan once a minute for expiry). A new job is read by its first provider status call within 5 s, also when started on another server. Running jobs keep the 5 s scan.
- Verified: bun test test/video-generation-idle.test.ts test/video-generation.test.ts test/tool-video-generate.test.ts = 5 pass, 0 fail (with --timeout 120000; the existing video tests already exceed Bun's 5 s default on HEAD); bun typecheck clean.

## 2026-11-27 offline conversation profile (attempt, no src change)

- Offline provider: `scripts/perf/fake-openai-server.ts` (OpenAI-compatible SSE, 200 x 4-char deltas, two `glob` tool calls per user turn, then text stop). Point a server at it with `OPENCODE_CONFIG_CONTENT='{"provider":{"openai":{"settings":{"baseURL":"http://127.0.0.1:PORT/v1"}}}}'` and isolated `XDG_*` under `/tmp/claude-1000/prof2/`. Driver: `scripts/perf/drive-conversations.ts <url> 3` (needs `OPENCODE_SERVER_PASSWORD`, Basic auth user `opencode`).
- Driven: 3 conversations, 6 persisted messages, 30 SSE events. Timings 8755 / 97 / 90 ms (first includes warmup).
- Profile: `bun --cpu-prof` only writes on exit (not used: process must not be killed). SIGPROF hook (`packages/cli/src/cpu-profile.ts`) wrote `cpu-1910718-*.cpuprofile`, but its timeline spans 662 s with only 6550 samples, so the full-profile shares are not usable.
- Last 10 s window (`WINDOW_S=10`, new option in `cpuprofile-shares.ts`): busy 9997 ms; `values` (SqliteClient.js:118, `@effect/sql-sqlite-bun`) 50.3%, `realpathCb` 31.9%, `setImmediate` 8.8%, `orderSelectedFields` (drizzle utils.js:220) 4.7%. The conversation itself (~0.4 s) was not captured in this window. These are background, not conversation, shares.
- Candidates: (1) SqliteClient `.values()` hot loop outside conversations (idle-tick DB polling), (2) `realpathCb` in background scans, (3) `orderSelectedFields` / `buildOrderBy` per-query drizzle cost.
- Next: a SIGPROF window started immediately before the driver, with the driver looped 20x so the window holds real conversation work.
