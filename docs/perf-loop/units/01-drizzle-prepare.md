STATUS: done
Prepared the hot drizzle statements in `packages/core/src/kv.ts` (get/set/remove) and `packages/core/src/automation.ts` (find, pending, due/row selection, next wake, rewake, active-row checks, leader claim/release, watch reconcile) once at layer init with `sql.placeholder` params.
Prepared INSERTs pass explicit `time_created`/`time_updated` placeholders so client-side timestamp defaults are not frozen at prepare time.
Behavior, SQL results and timing semantics are unchanged; only per-call query building is removed.
Area: DB query building. Compiled profile: drizzle buildQueryFromSourceParams/collectSQL/escapeName ~13-17% of service self time (boot+idle).
Task: find the queries that run repeatedly (loops in packages/core/src/automation.ts ~710/770/967, project sweeps, kv.ts, session list/history) and use drizzle `.prepare()` (built once at layer init) or hoist constant query builders out of hot functions. Files: packages/core/src/kv.ts, packages/core/src/automation.ts only.
