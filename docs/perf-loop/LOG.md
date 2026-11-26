# perf-loop LOG
2026-11-26 SCOUT#1: compiled cpu-prof service (boot+60s idle, copy of live 405MB DB): boot 1.2 CPU-s, idle ~2%/core, RSS 146MB.
Composition (self time): Effect runLoop/anon ~35%, drizzle query build (collectSQL+escapeName+buildQuery) ~13-17%, AsyncResource/scheduleTask ~7%.
Note: build-all-2 service was hot only in the real environment (plugins/MCP/clients), not in isolation.
2026-11-26 slice1 (units 01-03): prepared drizzle statements in kv.ts + automation.ts; automation loop dormant (doorbell only) with no active rows; integration scrub merged into one 30s fiber that no-ops when nothing is due. typecheck clean; automation/kv tests: same 4 env failures as baseline. Not yet built/A-B'd (gate pending).
