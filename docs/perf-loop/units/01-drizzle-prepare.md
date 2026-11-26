STATUS: open
Area: DB query building. Compiled profile: drizzle buildQueryFromSourceParams/collectSQL/escapeName ~13-17% of service self time (boot+idle).
Task: find the queries that run repeatedly (loops in packages/core/src/automation.ts ~710/770/967, project sweeps, kv.ts, session list/history) and use drizzle `.prepare()` (built once at layer init) or hoist constant query builders out of hot functions. Files: packages/core/src/kv.ts, packages/core/src/automation.ts only.
