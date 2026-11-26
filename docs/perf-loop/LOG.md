# perf-loop LOG
2026-11-26 SCOUT#1: compiled cpu-prof service (boot+60s idle, copy of live 405MB DB): boot 1.2 CPU-s, idle ~2%/core, RSS 146MB.
Composition (self time): Effect runLoop/anon ~35%, drizzle query build (collectSQL+escapeName+buildQuery) ~13-17%, AsyncResource/scheduleTask ~7%.
Note: build-all-2 service was hot only in the real environment (plugins/MCP/clients), not in isolation.
2026-11-26 slice1 (units 01-03): prepared drizzle statements in kv.ts + automation.ts; automation loop dormant (doorbell only) with no active rows; integration scrub merged into one 30s fiber that no-ops when nothing is due. typecheck clean; automation/kv tests: same 4 env failures as baseline. Not yet built/A-B'd (gate pending).
2026-11-26 slice2: unit 05 service-registration poll stats the file and re-reads only on change (cli service tests: same failures as baseline; one flaky test passes alone). unit 04 video tick REJECTED: 2 fail vs 1 baseline under TestClock; reverted.

## Cycle 1 (10:49-11:20)
- core session/model-request.ts, projector.ts: memoized per-message LLM conversion and tool-schema stringify; new prompt-cache-prefix test (passes). Gain unmeasured.
- server handlers/event.ts: hoisted invariant heartbeat/headers out of per-subscriber setup. Small.
- client service-timing/connection: probe timeout 2s->5s, unresponsive kill needs 4 failures over 30s, SSE stall 45s->90s. Targets the service-SIGTERM/"Event stream stalled" churn seen in logs at 13:42Z.
- REVERTED: message-updater.ts rewrite (65 type errors), inbox.ts prepared statements (transaction-handle/typing risk). Units 14 history, 15 llm-runner: workers died ("Failed to execute statement"), not done; carry to cycle 2.

## Cycle 2 (12:11-12:41)
- core config/plugin skill.ts + compatibility.ts: refresh no longer clears and recreates every native watcher; only vanished keys are pruned, and each subscription is scoped to its watch fiber (no unused subscriptions per refresh). Targets the ~820 watcher-subscribe / 627 watcher-started churn per few minutes seen in logs. Gain unmeasured.
- instruction.ts: scoped subscribe-in-fiber kept; directory-grouped entries watch REVERTED (tests pin one file-watch per file).
- REJECTED: unit 14 history cache (2x memory, deepEquals not cheaper), unit 15 llm runner (cwd cached across retries, dropped ...prepared spread).
- Scout: docs/perf-loop/units/19-scout-watchers.md. Open: global skill-root scan memoization (needs invalidation design).
- Build rule: always `--single` (linux-x64) with OPENCODE_VERSION=2.4.1 OPENCODE_CHANNEL=latest.

## Cycle 3 (13:01-13:31)
- client solid/connection.ts: event-stream reconnect now backs off exponentially (1s..30s) with jitter instead of a fixed 1s, so clients that lost an overloaded service do not re-dial in lockstep.
- Scouts: 22 persistence (top fix: single-statement event_sequence upsert in bus.ts, deferred: touches event ordering), 23 fanout, 24 skill-scan memo design (deferred: global cache correctness hinges on watcher events).
- REJECTED: unit 25 yield during SSE fanout (can reorder events across concurrent publishes).
- Observed after cycle 2 install: service 31 min up, ~17% CPU, 0 stalls/unplanned shutdowns/bind failures in log since restart.

## Cycle 4 (13:47-14:12)
- core bus.ts: the per-durable-event event_sequence SELECT is prepared once (sql.placeholder). core session/projector.ts: three fixed assistant-message SELECTs prepared once per db handle (WeakMap). Commit 35a8b126ba. Gain: removes per-event SQL building; small, not measured.
- Gate: typecheck core/server clean, 459 affected tests pass, linux-x64 build smoke-tested.
- Finding: busy_timeout=5000 with synchronous SQLite means a competing writer (e.g. --standalone run on the same DB) can block the service loop up to 5 s; reduce extra servers on the live DB, not the timeout.
- Memory pressure on the host (35 of 40 GB used by Java/browser) paused the gate briefly.

## Cycle 5 (14:23-, in progress)
- Scout 27 (runner step). Applied: to-llm-message.ts finds the last output item once instead of slice+some per reasoning item (commit 15db071242; only affects cut/errored messages, tiny gain). Typecheck core clean, 340 runner/request tests pass.
- Rejected: publish-llm-event double buffering (values is needed for the final join, pending is the reset batch); record() tool scan (short-circuits, handful of tools per step); prompt.ts structuredClone (per prompt, isolates plugin hooks).
- Held (medium risk, need design): duplicate transcript/estimate per step (llm.ts:258/267), per-step snapshot capture skip (step.ts:80, :291).
- Honest note: the remaining per-event hot-path wins are now small; the larger costs are per-step (snapshots, transcript rebuild). Not shipped yet; waiting for a bigger batch.
- Cycle 5 design review: REJECTED transcript reuse (estimate converts only anchor-onward, request converts all; per-message toLLMMessages memo from cycle 1 already shares the conversion work; reuse risks compaction triggers). REJECTED snapshot skip (start capture overlaps the provider request, off the critical path; end capture feeds the persisted Step.Ended snapshot field and the worktree can change outside the step).
- Cycle 6 review of scout 22 persistence fixes: #1 (single upsert RETURNING in bus.ts) cannot remove the initial read: seq is needed before projectors run and commit(seq) uses it, so only the prepared read (done in cycle 4) is safe. #2 (setAssistantTime json_set) and #3 (messageWrites without part re-read) change write shape inside the projector; they failed typecheck/risk review in cycle 1 and need a tests-first design with row-for-row persisted-data comparison before any edit. Not attempted blind.
- Cycle 6: unit 28 (persistence row test) worker reported done but wrote no file (verified by fd/git status). Unit marked failed; the persistence safety-net test is still to be written.
- Cycle 6 correction: unit 28 dropped. packages/core/test/session-projector.test.ts (46 tests, 122 table refs) already covers row-level projection incl. part_rows, forks, reverts and blob release; it is the safety net for any projector change. Scout-22 #3 (skip part re-read in messageWrites) REJECTED: the re-read (projector.ts:596) decides inline vs session_part storage and keeps newer-release rows compatible; it is the legacy part_rows:false path, not the default.
- Cycle 7 scout 29 (memory growth; worker run reported stale but findings were on disk and verified by reading). REJECTED: idle WebSocket sweep in model-transport.ts (sockets are kept after `completed` on purpose for checkpoint continuation, rotate at 55 min; sweeping sooner changes continuation/caching behaviour). Environment/warming/provider-discovery/plugin-update maps: tiny, bounded by historical config, not worth a change. Scout claim that no cycle-1 memos exist was wrong: they are WeakMaps (model-request.ts:109,249,286; projector.ts:319,455), GC-safe.
- Verified clean by scout: bus sessions, durable PubSubs, run-coordinator, inbox locks, event-feed subscribers, hooks callbacks, location-activity, mcp entries, watcher RcMap.
- Cycle 8 scouts 30 (fanout) and 31 (cold start). Both findings files verified on disk (31's run reported stale but wrote them).
  - 30 REJECTED: SSE JSON is already encoded once per event (event-feed.ts:53 `encoded ??=`); the per-subscriber cost is only string-to-bytes in the HTTP layer, and sharing bytes needs a string->Uint8Array interface change plus test churn for a gain proportional to a handful of clients.
  - 31 REJECTED (all five): well-known doc cache, global/system config cache, global agent/command/plugin scan cache and provider credential-file memo are all process-global caches whose correctness depends on watcher invalidation (stale until restart if an event is missed); the ancestor-walk arithmetic changes behaviour in stat-denying sandboxes. Candidate for a future design with explicit invalidation tests: well-known docs (HTTP per Location) and Azure `az` token reuse.
  - Observed, not chosen: MCP servers are connected per Location unless `pool: true`; changing the default alters connection/roots semantics and needs the user's decision.

## Cycle 9: restart root cause
- Log evidence (UTC): 17:35:04 a client (`opencode models`, callerPID 1725787) logged "Background service is unresponsive" streak=7 windowMs=30171 and SIGTERMed then SIGKILLed the 12-minute-old service (pid 1566874); all other clients logged "Event stream stalled". Trigger: a burst of ~30 `run --standalone` boots (worker pool + monitor) around 17:33-17:35 starved the service for just over 30 s (shared SQLite file, 5 s busy_timeout).
- Fix: packages/client service-timing.ts unresponsiveWindow 30 s -> 120 s (commit a30a377e6a). A hung service is still replaced, after 2 min. 60 service tests pass.
- Also seen: contender `serve --service` processes fail with "port 49374 already in use" (harmless noise).
