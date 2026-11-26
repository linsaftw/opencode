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
