STATUS: scouted

# Persistence write path for a streamed assistant response

## Where writes happen
- Deltas are live-only: `session.text/reasoning/tool.input.delta` are `Event.ephemeral` (packages/schema/src/session-event.ts:421,460,504). `publishEvent` for a non-durable event only builds routes and notifies (packages/core/src/bus.ts:478-484). Per delta: 0 SQL, 0 transaction.
- Persistence is per durable boundary: Text/Tool/Reasoning Started/Ended, Tool Called/Success/Failed, Step Started/FirstToken/Streamed/Ended -> `commitDurableEvent` (bus.ts:317) -> `SessionProjector.run` (projector.ts:353) -> `SessionMessageUpdater.update` (message-updater.ts:50) -> `partRowWrites` (projector.ts:621).
- Default is `experimental.part_rows=true` (schema/config/experimental.ts:42; projector.ts:334). `messageWrites` (projector.ts:507) is the `part_rows:false` fallback.

## Per-event cost (local server; `persist` defaults false at bus.ts:214)
- Every durable event: one `BEGIN IMMEDIATE ... COMMIT` (bus.ts:317,438) containing `SELECT event_sequence` (bus.ts:321), the projector writes, and `UPSERT event_sequence` (bus.ts:406). `INSERT event` (bus.ts:419) only runs when the server passes `persist:true` (server/src/workerd.ts:76).
- text/reasoning/tool-input `.started` -> `appendAssistantPart` (projector.ts:714): SELECT message (716) + INSERT part (720) = 2 statements.
- `.ended` and `tool.called/success/failed` -> `updateAssistantPart` (projector.ts:737): SELECT message+part join (742) + UPDATE part (819) = 2.
- `step.first-token`/`streamed` -> `updateOwnedAssistant` (message-updater.ts:264,269): SELECT message (projector.ts:482) + UPDATE whole envelope (696-711) = 2.
- `step.started`: SELECT assistant (482, miss) + SELECT current (465) + INSERT message/parts (860-895) + `touch` session_v2 (1150) = 4-5. `step.ended`: SELECT (482) + UPDATE envelope + `applyUsage` UPDATE session_v2 (1158) = 3.
- Net ~4 statements + 1 transaction per part boundary, ~6-8 per step boundary. No multi-statement batching; only multi-row part inserts are batched (`insertParts`, projector.ts:53).

## Reads / JSON / allocations
- Default path: one read and one part/envelope codec per event; no duplicate row read inside one event.
- JSON round trips: decode+encode the matched part (projector.ts:806-818) or the whole message envelope (695). Deltas do none.
- Only quadratic path is `part_rows:false`: per event `partRows` reads every part (508), `writeParts` `JSON.stringify`-compares each (539), `updateMessage` re-encodes the whole row (555-575), and `getAssistant` already loaded all parts through `withParts` (580-585) -> 2 full part scans + O(n) stringify per event. An inline-only assistant row rewrites its full text every event (568-570), O(text) per event.
- Per-event allocations: `MessageUpdater.update` rebuilds the ~50-case `Match.discriminatorsExhaustive` matcher on every call (message-updater.ts:86-88), plus the adapter closure object (projector.ts:357-456), immer `produce`, and `Schema.encodeUnknownSync` of event data (bus.ts:328) and part/message bodies. `Match.add` copies the cases array, so the matcher is the largest allocation.

## Top 3 safe fixes
1. `packages/core/src/bus.ts:321-328,406-417`: when `input === undefined`, replace the initial `SELECT event_sequence` and the trailing `UPSERT` with one `INSERT ... ON CONFLICT(aggregate_id) DO UPDATE SET seq = seq + 1 RETURNING seq` run before the projector. First event still yields 0, later events yield prev+1. Removes one query build + statement per durable event (the highest-volume saving). Keep the existing path for replay (`input` set). Risk: low; `durableLocks` already serialises per aggregate and all of it is one transaction.
2. `packages/core/src/session/message-updater.ts:264-272` + `packages/core/src/session/projector.ts:690-712`: add adapter `setAssistantTime(messageID, field, millis)` running one `UPDATE session_message SET data = json_set(data, '$.time.<field>', ?) WHERE id=? AND session_id=? AND type='assistant' AND json_type(data,'$.time')='object'`. Wire `session.step.first-token` and `session.step.streamed` to it. Persisted value is identical, but SELECT + full decode + full encode + update collapse to one statement. Risk: low; a missing row/no-op update matches today's `if (!assistant) return`.
3. `packages/core/src/session/projector.ts:508-552,555-575`: in `messageWrites` stop re-reading all parts. `editAssistant` (586-595) already holds the decoded message and the produced `content`; pass it into `updateMessage` so `writeParts` compares only `existing[index]` against `content[index]` and updates just the changed ordinal(s), and reuse the known `content.length` instead of `partRows`. Removes one full `session_part` scan and N-1 `JSON.stringify` per event. Risk: low only for the `part_rows:false` fallback; rows stay byte-identical. The inline-only sub-case (no part rows) stays O(text) and needs a one-time migration to part rows, which changes row shape and is out of scope here.
