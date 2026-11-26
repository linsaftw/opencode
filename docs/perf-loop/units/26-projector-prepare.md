STATUS: done
# Unit 26: prepare the hottest fixed SELECTs in the session projector once
File (only this): packages/core/src/session/projector.ts
Read docs/perf-loop/units/22-scout-persistence.md and packages/core/src/kv.ts (the prepared-statement pattern with sql.placeholder) and packages/core/src/bus.ts (the new sequenceQuery near `const { db } = yield* Database.Service`).
Every durable part/step event runs the same few SELECTs (assistant message by id ~lines 465 and 482, message+part join ~742, message ~716) and drizzle rebuilds the SQL each time. Build them once with .prepare() + sql.placeholder where the `db` handle is the long-lived service handle, and call .get({..}) at the call sites. Rules: ONLY plain read SELECTs with simple equality filters; do not touch writes; same columns, same filters, same result shape. If the `db` used inside the projector adapter is a per-transaction handle that is not available where the layer is built (check how the adapter gets `db`), make NO change and set STATUS: no-change with the reason. Do not add try/catch, any, or aliased imports.

Prepared the three fixed assistant-message SELECTs in projector.ts once per long-lived db handle (WeakMap memo) with sql.placeholder values.
Removes per-event drizzle SQL construction for the assistant-only lookups, leaving identical SQL/columns/filters and result shapes at the call sites.
Risk: low; the message+part join was left inline because its optional call-id/incomplete-reasoning filters are not simple equality, so it is not a fixed prepared statement.
