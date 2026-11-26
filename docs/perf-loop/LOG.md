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
