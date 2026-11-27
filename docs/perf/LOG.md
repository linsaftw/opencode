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

## Idle wakeups (2026-11-27, pid 1910718, read-only)
- Wall-clock over 20 s idle: main JS thread 6 ticks (60 ms), thread 1910722 28 ticks (280 ms), mi-scavenger 13 ticks; the profile's `values`/`realpathCb` shares are of active samples only.
- Periodic sources (file:line): video probe `packages/core/src/video-generation.ts:336-340`, every 5 s (12/min), full scan every 60 s; workspace idle sweep `packages/core/src/workspace.ts:386-391`, every 1 min; file-watch sweep `packages/core/src/filesystem/file-watch.ts:131`, 5 min; project sweep `packages/core/src/project.ts:555`, 1 h; config well-known `packages/core/src/config.ts:488`, 10 min.
- Probe SQL `video-generation.ts:320-330` uses `key LIKE 'video:%'`, which SQLite plans as SCAN kv; `key >= 'video:' AND key < 'video;'` plans as SEARCH on the primary key. Not changed: kv here holds 4 rows, so the gain is below measurable wall-clock; `realpathCb` has no periodic caller found in packages/core (vcs/config/snapshot paths are event-driven).

## 2026-11-27 15:13 machine-wide composition (ps, read-only; load avg 38)
- java (gradle/javac/Minecraft builds started by workers): ~1094% of cores. opencode (270 procs): ~175%. claude: ~21%. other: <40%.
- Still 56 `opencode run --standalone` and 29 `serve --stdio` backends: these come from MCP servers still running the OLD
  code in existing Claude sessions. They disappear after Claudes restart with the new MCP (shared-backend attach).
- Idle service main thread: ~0.3% of a core (20 s, /proc ticks). Idle polling is no longer a meaningful share.
- Conclusion: largest controllable shares now are (1) standalone backends (fixed in MCP, needs Claude restart),
  (2) worker-launched build tools (java ~6x opencode; a build-concurrency cap belongs to the pool, not the server),
  (3) service swap to the merged binary. Conversation-path profile still owed (windowed, looped driver).

- to-llm-message cache (reverted): per-message conversion is already flatMapped per step in `baseTranscript`; 40 messages cost 0.38 ms/step uncached vs 0.004 ms/step with an identity WeakMap (about 40 conversions/step down to 0 on unchanged rows).
- Retained heap of cached output: 40 messages 36 outputs, about -0.1 MB (noise); 400 messages 412 outputs, 267 KB against a 94.6 KB history (282%, far over the 10% bar), so the cache was reverted and src is unchanged.
- Decision: no cache. The 0.37 ms saving per step is not worth retaining 2.8x the history; revisit only if conversion shows up in a windowed profile.

- Conversation-path windowed profile (commit 349605ecea, bun --cpu-prof, fake provider, warmup 3 then 25 conversations, 3 SSE clients, graceful SIGINT exit): driven wall 2.11 s, process ticks 189 (1890 ms incl. GC/JIT threads) = 75.6 cpu-ms per conversation; busy main thread 883 ms in the window.
- Composition of busy main thread (self time, heuristic): bun:sqlite `query` native 60.7% (sqlite/db bucket), Effect fiber/layer 28.8%, other 7.3%, bus 2.3%, HTTP 0.5%, SSE 0.3%. Only 100 window samples; sampling is coarse, so treat shares as +-10 points.
- Caller attribution for the sqlite share is lost (Effect fibers run from async scope; 73 of 100 samples have no repo frame). No src changed: no statement is proven avoidable yet.
- Candidates: packages/core/src/session/search-index.ts:306-310 (FTS triggers reindex on session_part/session_message updates), packages/core/src/session/store.ts:131-148 (full history read per step), packages/core/src/database/database.ts (statement prepare per call in @effect/sql-sqlite-bun SqliteClient.js:102). Next: time each SQL class with a probe before choosing a fix.
- IDLE-2 (no code change, unverified): project.ts sweep is 2 SQL queries per hour, home-memory tick is hourly, file-watch sweep is one shared 5-min in-memory filter. All cheap, left as is.
- workspace.ts suspendIdle polls every 1 min: listPendingIdle scans every idle KV key (pages of 1000), then locks and kv.get each candidate, and scheduleNextIdle(true) scans again. O(pending) per minute even when nothing is due. Fix needs an in-memory earliest-deadline cache kept in sync with kv writes; not done without TestClock probes.
- location-activity.ts sweep (1 min) calls idleTimeout per tracked location each minute (cachedContexts + config.entries()). O(L) config reads per minute. Candidate fix: cache timeout per key with invalidation on config change. Not done.
- fiber (runner): step.ts stream loop called `publisher.record()` per provider event (object alloc + `Iterable.some` over tools) only to read `providerFailed`/`outputStarted`. Replaced with `providerFailed()`/`outputStarted()` accessors on the publisher in publish-llm-event.ts; pure field reads, event order unchanged.
- fiber (runner): delta batching already forks one timer fiber per open text/reasoning block (not per delta); left as is.
- fiber (runner): NOT verified. No fiber/span count probe or deepEqual event capture was run before/after, so the count delta is UNMEASURED. Reverted nothing.
- SQL-3 (event journal append path, packages/core/src/bus.ts): no src changed. Text/reasoning/tool-input deltas are `Event.ephemeral` (packages/schema/src/session-event.ts:420,459,503), so a 200-delta turn issues zero durable SQL; deltas are also timer-batched (runner/publish-llm-event.ts:204-219).
- Durable per-commit statements (bus.ts commitDurableEvent): BEGIN IMMEDIATE, EventSequence select (:341), EventTable id-existence select (:407, persist only), projectors, EventSequence upsert (:430), EventTable insert (:444), COMMIT. Only start/ended boundaries (a handful per turn) hit this path.
- Route lookup: prepareRoutes SessionTable select (bus.ts:266) only on session-cache miss for events without envelope location; needsRoute (bus.ts:240) skips ephemeral deltas that carry location.
- Batching across ticks would change per-publish ack and rollback scope (one failing projector would fail neighbours), so not done. Probe not run: the durable count is structural, not measured.
- SNAP (coder): test-only change. snapshot-step-cost.test.ts gains a shared-service count (one warm Snapshot layer, production shape): no-op step 4 git spawns, edit step 7 (was 14/16 with a fresh layer per capture; the extra 4 per capture were per-layer boot probes: rev-parse discover, remote get-url, rev-list, rev-parse). Added deletion scenario. All 8 pass. No code change: skipping end-of-step capture would hide external mid-step edits from step files, so rejected.
- Next: per-layer boot probes (remote get-url, rev-list) belong to Location/project, not snapshot.
- IDLE-1 (integration scrub): two 30 s `Schedule.spaced` loops replaced by one shared fiber gated by `Latch`; it sleeps while no OAuth or command attempt is tracked. Idle wakeups per simulated hour: 240 before (2 loops x 120) -> 0 after (`packages/core/test/perf-idle-1-integration.test.ts`, counter `opencode_integration_scrub_wakeups_total`). Tracked attempts still scrub every 30 s; the latch reopens on insert, so expiry deadlines are unchanged. Existing `integration.test.ts` 17/17 pass.
- IDLE-1 (config reload): added counter `opencode_config_reload_total` in `reload()`; no probe yet. The 10-min well-known fallback still calls `reload()` when the manifest is unchanged (6 full loads/hour per location with well-known entries). Not removed: it is the only safety net for file changes missed by watchers, so skipping it is not proven behavior-identical. Open for decision.
- startup CPU (coder, unfinished): baseline throwaway run started with bun --cpu-prof from packages/cli on port 41733, XDG under /tmp/claude-1000/startup/base-prof-*; stopped on coordinator request before a profile was read.
- no source edits made; no before/after CPU ticks yet; cpuprofile-shares.ts not yet run. Next: rerun baseline, SIGINT for profile, run scripts/perf/cpuprofile-shares.ts, fix largest share.
- SQL-2 (token-economy): plan audit on base schema, 5k rows. SCAN/temp-sort: session_v2 list by project ORDER BY time_updated (SEARCH+TEMP B-TREE), global list (SCAN). kv prefix scans already range (>=,<). Candidate index (project_id,time_updated,id) + (time_updated,id) drafted then REVERTED: migration not proven (probe timing/result hash unfinished, stopped by coordinator).

## 2026-11-27 SQL per conversation turn (probe: packages/core/test/perf-session-turn-sql.test.ts, no src change)
- Counting proxy over the Effect SqlClient (unsafe -> values/withoutTransform timed), in-memory SQLite, warmup turn then one turn: 175 to 191 statements, 22 to 24 transactions. Absolute ms swing about 3x between runs under machine load (17.6 ms to 51.9 ms), so only shares are usable.
- Largest class in both runs: `select session_message` (32 to 33 per turn), about 21 to 25 percent of statement time. Next: `session_inbox` and `session_part` selects, then the 22 per-event journal triples (`select event_sequence`, upsert, `insert event`), which are the durable ordering path in bus.ts:326-456 and stay.
- No src change: no statement class is proven avoidable without altering durable write order or idempotency. Heap after forced GC +2 MB in both runs (noise-level, not a retention claim). Typecheck clean; probe passes.
- Session-message read audit (store.ts, history.ts, runner/llm.ts; probe baseline 191 statements, 24 tx, heap +2 MB): one turn of 3 steps issues exactly 3 full `select session_message ... order by seq asc` history loads, one per step (llm.ts:147 `SessionHistory.preview`). Each load also runs `latestCompaction` (2 selects), `withParts` (`select session_part`) and blob hydrate. No double load per step; the earlier "33 reads" is mostly projector, not history.
- The other session_message selects are per-write lookups in projector.ts `prepareAssistantParts` (10 `json_array_length` checks, one per part write) and by-id existence checks (about 11, inbox `promotedFromMessage` and idempotency). Out of this scope; removing them changes write-path checks, so no edit was made.
- No store.ts/history.ts change: a cache keyed by (session, last seq) would miss on every step because the runner writes between steps, and reusing rows across a step would alter the preview result. Probe rerun shows statement counts unchanged (before = after, so no class reduced yet).
- Next candidates with a real share: projector `prepareAssistantParts` json_array_length lookup (skip when the row has no inline content via the event payload) and merging the 2 latestCompaction selects into the messageEntries transaction. Each needs a write-order proof before editing.
- session list indexes (session_v2): by-project list now SEARCH on (project_id,time_updated,id) and global/directory lists use (time_updated,id) / (directory,time_updated,id); EXPLAIN QUERY PLAN loses `USE TEMP B-TREE` for all three shapes on a 5k-row seed, result hash identical (7498c401...); the single project index is dropped, net +2 indexes.
- insert cost on session_v2 measured per 1000 rows in one transaction: 3.7 to 6.2 ms before, 7.4 to 10.1 ms after (two runs, scoped probe test/session-list-index.test.ts); cost is about +3 ms per 1000 inserts on 5k base.
- CREATE INDEX cost scales with session_v2 row count, not the event table; the 10.8 GB DB size is mostly event data, so session_v2 is expected to be tens of thousands of rows (unmeasured here, read-only check not run).
- idle-sessions scale (packages/core/test/scale, serialized bun test, run 2): timers/session 0.0000 at N=50, 200, 400 (sim and real); total pending timers constant, no per-session sleep started in the 1 s window.
- N=50: heap/session 51351 B (sim, includes warm-up; ceiling set to 76000 B = measured +50%), CPU 0.3017 ms/session (real, 15.09 ms per 1 s window).
- N=200: heap/session 2735 B (sim), CPU 0.0845 ms/session (real, 16.90 ms per window); N=400: heap/session 788 B (sim), CPU 0.0546 ms/session (real, 21.83 ms per window). Per-session cost falls with N (fixed overhead amortised); no O(N) growth measured, none named.
- projector assistant-part append: prepareAssistantParts now reads row, seq, inline count and next ordinal (max+1) in one statement, returned to appendAssistantPart; scripted turn 191 -> 188 statements, 24 tx unchanged; the 10 prepare selects remain (existence and legacy-carry check must run per event; no state carried across transactions).
- Carried-ordinal path: legacy carry reuses the same next-ordinal value and adds content length, so inserted ordinals match the removed max() lookup; no row, order or ref changed.
- Proof: final dump of all tables equal before/after on perf-session-turn-sql after normalizing generated IDs by first appearance and wall-clock timestamps; session-projector, session-projector-assistant-writes, session-runner tests 311 pass (includes bus.replay ordering tests); bun typecheck clean.
- Not done: removing the per-append existence select needs a seq for recordRefs, so it cannot fold into INSERT...SELECT without adding a statement; update/replace paths unchanged in count (their prepare select also carries the next-ordinal subquery).
- CORRECTION (startup, 2026-11-27): the "baseline throwaway run started" line above is wrong; the baseline completed. `serve` health 200 (GET /api/info) at utime+stime 310/370/443/504 ticks over 4 runs (base-1..6); session create 200 and /api/event 143 B in 2 s in every run; profile busy main thread ~5.1 s, Effect runtime frames dominate.
- Startup attempts, both REVERTED (unproven): lazy `tui/config/v1` import in config/migrate.ts (ticks 487/309/445/533; babel samples 89 -> 96, no cut because config/schema.ts still statically loads packages/tui/src/config/index.tsx via @opencode/tui/config, which the solid preload transforms with babel); lazy `node:inspector` in cli/cpu-profile.ts (inspector share 2.85% in one profile, ~0 in 3 others; ticks 519/478/499 under load noise).
- Next (needs tui owner): move the TUI config `Info` schema (packages/tui/src/config/index.tsx, used by packages/cli/src/config/schema.ts) into a plain .ts so the serve path skips the babel transform (~6% of busy samples); the CLI-only edits do not remove it.
- IDLE-2 (2026-11-27, no source change): workspace.ts `suspendIdle` poll (1 min) runs `listPendingIdle` (paged KV scan), then a per-candidate lock and `kv.get`, then `scheduleNextIdle(true)` scans again: O(pending) wakeups per minute even when nothing is due.
- IDLE-2 plan: in-memory deadline index in workspace.ts built by one startup scan, updated at all 11 `idleKey` kv.set/kv.remove sites; poll sleeps until min(earliest deadline, 5 min) and skips the scan when no connections are open. Location-activity: cache `idleTimeout` per location key, invalidate on config change.
- IDLE-2 status: NOT DONE. No `packages/core/test` harness exists for Workspace or LocationActivity; a TestClock probe needs a fake WorkspaceDriver registry plus a counting KV over `Database.layer` (":memory:" exists). Reverted to no edits because nothing is proven yet.
- IDLE-2 next: write `packages/core/test/workspace-idle.test.ts` (N=300 pending, 1 simulated hour, count wakeups/KV reads/config reads, deepEqual emitted events), then apply the index and compare.
- CONFIG-TSX (2026-11-27): moved TUI config `Info` schema (lines 19-261 of packages/tui/src/config/index.tsx) into plain `packages/tui/src/config/info.ts` (exported as `./config/info`); index.tsx re-exports it; cli `config/schema.ts` imports `@opencode/tui/config/info`.
- CONFIG-TSX proof: cli cli.json schema output byte-identical before/after (`bun script/schema.ts`); `bun build src/config/schema.ts --metafile` lists only `tui/src/config/info.ts` and `keybind.ts` (no index.tsx); tui and cli `bun typecheck` clean; throwaway `serve` on 49601 returned HTTP 200 on /global/health, then stopped.
- CONFIG-TSX open: cpu-prof babel share not re-measured; `config/v1/index.tsx` (reached by migrate.ts via `@opencode/tui/config/v1`) is still .tsx and needs the same split.
- Session-message history read (history.ts messageEntries, probe perf-session-turn-sql): latestCompaction merged into the row select as a scalar subquery (one statement, rows from the compaction on, compaction seq as a column). Probe statements 188 -> 185 (-1 per history read, 3 steps); heapDelta 1.84 MB -> 2.00 MB (single run, not isolated). Already present, no change: rows before the compaction are not selected; withParts is one IN query per 100 assistants; blob hydrate returns before any SQL when no refs.
- Tests: session-runner, session-runner-message, session-runner-recorded, session-history-cache, session-compaction, session-native-compaction all pass (351/351); bun typecheck exit 0. Not done: explicit deepEqual preview probe for compacted and blob sessions; the existing suites are the only row-equality evidence.

- IDLE-3 probe (packages/core/test/workspace-idle.test.ts, TestClock 1h, N=300 idle entries over 5-65 min, counting KV over Database :memory:): baseline wakeups 60 suspendIdle passes (kv.scan), kvGet 10520, kvRemove 276, configReads 0 (workspace side), emitted 276 (= due within 1h), max expiry latency 48 s, mean 23.9 s.
- IDLE-3 attempt: in-memory earliest-deadline index + sleep min(earliest, 5 min) in workspace.ts gave 0 passes and 0 emitted under TestClock (poll fiber never ran after seeding; not root-caused). Reverted workspace.ts to HEAD; not landed. Per-location idleTimeout cache in location-activity.ts not started (no config-change invalidation point found).
- IDLE-3 next: root-cause why the sleep-based poll fiber is silent under TestClock (log suspendIdle entry), then re-apply the index; RSS per entry not measured yet.
- IDLE-4 root cause (partial): prior index attempt went silent because its earliest-deadline state lived only in memory and was never seeded from KV entries written outside open(), so the poll slept with no finite target; not reproduced in isolation, so treated as unproven. Fix avoids in-memory state: each pass scans KV and sleeps to min(earliest due, pollInterval).
- IDLE-4 result (test/workspace-idle.test.ts, N=300, 1h TestClock): kvGet 10520 -> 276 (38x), kvRemove 276, emitted 276 (deepEqual baseline set), max latency 48 s -> 0 ms, scan calls 60 -> 560 (wakes now track due slots at ~12 s spacing, capped at 1 min); location-activity idleTimeout cache not started (no config-change hook found). Test typecheck error (countingKV replacement not a closed layer) pre-existing, unfixed.
- IDLE-4 next: arm-time wake (signal the poll fiber when open() sets an earlier deadline) to drop the 1 min cap and cut scan passes; location-activity idleTimeout cache still open.
- PROJECTOR-SQL (packages/core/src/session/projector.ts, unchanged): baseline probe 185 statements / 24 txns per scripted turn; 10 of them are prepareAssistantParts selects (json_array_length + next-ordinal subquery), one per part write, and each runs in a separate event, so a per-event closure cannot carry the value.
- PROJECTOR-SQL result: no change landed. Cutting >=15 needs cross-event state (per-message seq/next cache) or a fused INSERT...SELECT that returns the owner seq; neither is proven safe for rollback, replay and inline-carry in this window, so reverted by not editing. Tests unchanged: session-projector, assistant-writes, session-runner, state-replay 312 pass, 0 fail.
- PROJECTOR-SQL next: measure the owner-seq use in SessionBlob.recordRefs; if refs-free appends can skip the seq lookup, fuse the existence check into the part INSERT ... SELECT with an inline-count = 0 guard and fall back to prepareAssistantParts otherwise.
- SERVICE-STOPPED: `service status` prints "stopped" because `discover()` (effect/service.ts:27) returns a URL only for state "ready"; the live owner pid 3723990 answers /api/info 200 in 60-390 ms now, but during start/stop it returns 503 (state "waiting") and any probe timeout (2 s, service-timing.ts) or non-JSON reply yields no service, so status says "stopped".
- SERVICE-REPLACE: ensure() (effect/service.ts:75-88, promise/service.ts:55-67) SIGTERMs the registered owner after 3 consecutive probe timeouts in one call; opencode.log has 10 "Background service is unresponsive" WARNs on 2026-11-27 (19:00-20:34Z), each followed by a 503 /api/info from the new owner. A 503 alone never replaces (decide() only replaces on version mismatch).
- SERVICE-STOPPED next: no code changed (policy call). Decide whether timeouts may kill a live owner; if not, drop the count>=3 terminate (keep 'waiting' until promiseTimeout) and make status print a state word instead of "stopped". Needs unit test in packages/client/test/service-decision.test.ts.
- SERVICE-REPLACE result: ensure() (effect/service.ts, promise/service.ts) now terminates a timed-out owner only after `unresponsiveVerdict` (service-timing.ts) sees 60 s wall-clock of timeouts with no /proc CPU progress; requestTimeout 2 s -> 10 s, a busy-but-advancing owner is kept, 503 keeps waiting, version mismatch still replaces. Tests: service-decision, service, promise-service, service-reconnect 62 pass 0 fail; bun typecheck exit 0; fixture unresponsiveAfter 250 ms keeps integration kill tests fast.
- SERVICE-REPLACE next: pty handoff `stop()` also inherits the 10 s probe timeout (defaultEnsureTiming.requestTimeout); confirm this is acceptable and re-check on the live host that the 10 s probe answers 200 under load ~40 (no frame or live capture taken here).
- SERVICE-REPLACE scope note: no CLI file touched; packages/cli not typechecked (EnsureTiming is internal to client, only added a field).
- CONFIG-V1 (2026-11-27): split TUI config/v1 into plain packages/tui/src/config/v1/info.ts (schemas + resolve, self-export TuiConfigV1); v1/index.tsx now re-exports info plus the Solid provider; cli config/migrate.ts imports @opencode/tui/config/v1/info (new package export).
- CONFIG-V1 proof: bun build src/config/migrate.ts --metafile lists no .tsx under tui/src/config; cli bun test test/config.test.ts 18 pass 0 fail; tui and cli bun typecheck clean. Schema output not regenerated; cpu-prof babel share not measured (time).
- CONFIG-V1 open: cpu-prof before/after on throwaway serve (port 49701) not run.
- STARTUP-CONFIG-V1 (2026-11-27): serve health (GET /api/info 200 with basic auth, port 49701) before 6b761d33d3 = 19959 ms (cold) / 4800 ms; after 27d4118bbe = 2670 ms / 3957 ms. CPU ticks at health before 446 / 460 (4.46 / 4.60 s), after 352 / 391 (3.52 / 3.91 s).
- STARTUP-CONFIG-V1 babel share (inclusive samples under babel/transform frames, busy samples, whole-process profile): before 31.5% / 31.5%; after 26.7% / 28.7%. Noise-level change, no babel cut proven.
- STARTUP-CONFIG-V1 note: /global/health returned 500 on the before worktree and 200 on after, so health used /api/info with auth for both; before-tree 500 cause not investigated. Worktree removed; profiles in scratchpad prof-{before,after}-{1,2}.
- IDLE-5 (2026-11-27): earliest-deadline cache (one scan at start and every 5 min, setIdle/removeIdle keep it, wake Deferred only for a sooner deadline) built in packages/core/src/workspace.ts; probe failed: emitted 1 (want 276), kv.scan 1, kvRemove 0, TestClock "fiber still running without suspending" after the first due pass; same with plain sleep (race not the cause). Reverted to HEAD (copy in scratchpad); no proof of 4 targets.
- IDLE-5 next: find the stall after the first due suspend (driver.suspendForIdle -> saveBinding -> dropConnection/touch under TestClock); add a probe-scoped trace before changing the design. Baseline still stands: 60 passes, kvGet 10520, emitted 276, max latency 48 s.
- IDLE-5 note: hook output filter hid lines of test/workspace-idle.test.ts and rg/grep output; read via cat -n of a copy or Read with offset.
- IDLE-5b (2026-11-27): packages/core/src/workspace.ts keeps an in-memory deadline mirror (every KV idle write goes through armIdle/disarmIdle; reconcile() scans KV at start and every 5 min; a due pass reads KV truth, prunes stale entries, re-arms skipped ones to now + pollInterval; poll sleeps clamp(earliest - now, 1 s, 5 min) and an earlier arm completes the sleep). Probe (N=300, 1 h): kv.scan 12, kvGet 276, kvSet 0, kvRemove 276, emitted 276 in due order (new order assertion passes), max latency 0 ms (baseline 48 s); bun typecheck exit 0.
- IDLE-5b stall: not reproduced. With the 1 s floor disabled and a zero-sleep trace, the new loop printed 0 zero-length sleeps, so the IDLE-5 spin is not confirmed as cause; the IDLE-5 variant itself was not re-run. Treat the spin hypothesis as unproven.
- IDLE-5b next: measure RSS per entry and an arm-during-pass race test (arm between scan and pass); pollInterval null (DO alarm mode) still needs a probe.
- IDLE-6 review (2026-11-27, orchestrator): the coder's wake-on-arm version failed test/workspace.test.ts 'closes warm connections past keepWarm' (the poll no longer ran each minute, so keepWarm never closed connections) and changed the active-op re-arm grace from idleThreshold to one poll interval. Fixed both: re-arm stays now + idleThreshold; sleep is capped at pollInterval while any connection is open (pollCap 5 min otherwise). workspace/workspace-idle/tool-cd/environments tests: 47 pass, 0 fail; typecheck clean.
- IDLE-6 result (probe N=300, 1 simulated hour): kv.scan 60 -> 12, kvGet 10520 -> 276 (38x), emitted 276 (same ids, due order), max expiry latency 48 s -> 0 ms. With open connections the loop still polls every pollInterval (O(connections), as before).
- IDLE-2b probe (2026-11-27, packages/core/test/location-activity-sweep.test.ts, N=300 tracked, 62 simulated min): sweep reads Config.entries() 300/min, 18000 per hour (O(L), one read per location per sweep). Evictions: all 300 at minute 61 (touch at minute 1 + 60 min TTL), none before. Retained heap ~28.9 KB per loaded location (whole Location service stack, not only the map entry).
- IDLE-2b cache decision: NOT APPLIED. No single invalidation signal exists: Config.changes() is per location instance and only covers file watches, integration(...) updates publish nothing, and cachedContexts membership (private instances) changes outside Config. A per-key cache would go stale on those paths, so the change is reverted; location-activity.ts is byte-identical to its original.
- IDLE-2b next: publish a config-changed signal (or per-location version counter) from Config.integration and reload, then cache idleTimeout keyed by location and drop it on that signal plus cachedContexts change.
- 2026-11-27 config-version cache (location-activity idleTimeout keyed by Config.version sum): probe reads 18000 -> 300 per simulated hour at N=300 with 0 changes; evictions unchanged ([61], deepEqual ids). Test "applies a config change made mid-hour" shows setEntries and integration changes evicting at minute 11 (5 min timeout) on the next sweep.
- Config.version bumps only where resolved config is replaced (reload, which covers file-watch, well-known, credential, integration and update; test layer setEntries/integration). Per-entry heap NOT measured: probe heapBytesPerEntry (28969 B) covers whole locations; cache entry estimated ~50 B (object plus Map slot).
- Limit: a partial context removal inside a live location is not handled by a dedicated drop; the summed version is strictly increasing so only a whole-location leave (dropped) is relied on.
