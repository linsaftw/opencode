STATUS: scouted (all 5 findings rejected cycle 14: per-event allocations of a few small objects or N~1-3 subscribers; #2 changes event granularity)
# Unit 33 (scout, read-only on source): per-event cost on the SSE/event fanout path
Read packages/server/src/event-feed.ts, packages/server/src/handlers (event/sse routes), packages/core/src/bus.ts publish path, and session/runner/publish-llm-event.ts. Find per-event work that scales with subscribers or history: re-encoding, per-subscriber allocation, unbounded queues, O(n) scans per event, repeated schema encode of the same event, delta events not coalesced. For each: file:line, quoted code, cost per event, minimal fix with identical observable output and ordering, risk. Verify every claim by quoting the code; earlier scouts overstated 5 of 10 findings, so say "unverified" when unsure. Top 5 under "## Findings". Edit no other file; re-read this file at the end.

## Findings

Scope: read-only. Reviewed `packages/server/src/event-feed.ts`, `packages/server/src/handlers/event.ts`, `packages/core/src/bus.ts` (`notify`, `prepareRoutes`, `publishEvent`), `packages/core/src/session/runner/publish-llm-event.ts`, and `packages/core/src/session/compaction.ts`. No source was edited.

### 1. Every SSE subscriber re-encodes the same shared frame string to UTF-8
`packages/server/src/handlers/event.ts:32`
```ts
output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
```
`EventFeed.frame` already serializes each event once (`packages/server/src/event-feed.ts:29-31`) and `publish` reuses that one string for every subscriber (`event-feed.ts:50-54`). But `Stream.encodeText` creates one `TextEncoder` per response stream and calls `encoder.encode(chunk)` for every chunk (`effect-smol/packages/effect/src/Stream.ts:9433-9436`), returning a fresh `Uint8Array` each time. With N clients this is N encodes and N byte-array copies of the identical frame per event, scaling with subscribers and payload bytes. The JSON/string work is not repeated; only the byte conversion is.
Minimal fix: convert the shared frame to a `Uint8Array` once in `EventFeed.publish`, pre-encode the per-connection `server.connected` frame and the constant heartbeat, and drop `Stream.encodeText` from the live response. Concatenated bytes are identical.
Risk: changes the `EventFeed.subscribe` element type and the existing string comparisons in `packages/server/test/event-feed.test.ts`; keep `frame()` returning the same string. Shared chunks must remain immutable, which the response layer already respects. Ordering and 15 s heartbeat timing are unchanged.

### 2. Compaction stream deltas bypass batching and publish one event per provider token
`packages/core/src/session/compaction.ts:795-797`
```ts
if (LLMEvent.is.textDelta(event)) {
  const next = { ...streamed, text: streamed.text + event.text }
  if (background) return Effect.succeed(next)
  return bus.publish(SessionEvent.Compaction.Delta, { sessionID, text: event.text }).pipe(Effect.as(next))
}
```
Text and reasoning deltas already coalesce on a 100 ms timer (`packages/core/src/session/runner/publish-llm-event.ts:107,202-217`). Compaction does not: every provider token runs `Bus.notify`, one `isOpenCodeEvent` lookup, one `JSON.stringify`, one queue offer per SSE subscriber, and one response chunk per subscriber. Compaction streams a summary of the full history, so this is thousands of events per compaction and scales with tokens x subscribers.
Minimal fix: buffer `Compaction.Delta` text on the same 100 ms cadence used by `fragments.append`, and flush the buffer before `Compaction.Ended`/`Compaction.Failed` (`compaction.ts:910,921`). The concatenated client-visible text and per-queue order are unchanged.
Risk: event count and timing become observable; any client or test that counts deltas or expects first-token immediacy changes. "Identical observable output" holds for the concatenated text, not for event granularity.

### 3. `EventFeed.publish` scans every subscriber for every event, even when type filters cannot match
`packages/server/src/event-feed.ts:51-52`
```ts
for (const [subscriber, types] of subscribers) {
  if (types && !types.has(event.type)) continue
```
When clients subscribe with `ctx.query.types`, each event still pays one `Set.has` per subscriber. With many filtered subscribers and a delta stream this is O(total subscribers) work per event even though only a few queues can match.
Minimal fix: maintain a type index (`Map<string, Set<Queue>>`) plus an unfiltered set; iterate only unfiltered queues and queues registered for `event.type`, and skip rendering when both are empty. Encoding remains once per event, and per-queue order is preserved because one publish completes synchronously.
Risk: extra index state to maintain in `subscribe`/unsubscribe; `fail()` must still fail all subscribers on an encoding error. Cross-queue ordering is unobservable, but do not publish separately per type, which could reorder events for a subscriber registered for several types.

### 4. `prepareRoutes` allocates two maps and a closure for every single-event publish
`packages/core/src/bus.ts:230-231`
```ts
const updates = new Map<SessionID, Location.Ref | undefined>()
const resolved = new Map<Event.Payload, readonly Location.Ref[]>()
```
Both are allocated for every single-event publish because `publishEvent` calls `prepareRoutes([event])` at `bus.ts:401` (durable) and `bus.ts:481` (ephemeral), then returns a route closure. A streamed delta that already carries an envelope `location` hits the fast path at `bus.ts:240-243` and continues, writing neither map, so the two maps plus the closure are garbage per token.
Minimal fix: allocate `updates` and `resolved` lazily on the first `set` and return a shared no-op route when neither was created, or skip `prepareRoutes` when the event has `location` and its type is not `session.created`, `session.forked`, `session.moved`, or `session.deleted`. Routing writes and bytes are unchanged.
Risk: must preserve the four routing exceptions and the `sessions`/`routes` updates for real routing events; low.

### 5. Map entry destructuring allocates one `[queue, types]` array per subscriber per event
`packages/server/src/event-feed.ts:51`
```ts
for (const [subscriber, types] of subscribers) {
```
The Map iterator yields a fresh two-element array for every entry, so this adds N array allocations per event on top of the `Set.has` checks, scaling with subscribers and token rate. The `Set` filters themselves are already precomputed at subscribe time (`event-feed.ts:79`).
Minimal fix: use `subscribers.forEach((types, subscriber) => { ... })`, or iterate `subscribers.keys()` and read `subscribers.get(queue)`. Insertion order is preserved and deleting the current queue on overflow remains safe.
Risk: none observed; inside `forEach` turn `continue` into `return`. The GC magnitude is unverified; this is spec-level per-entry allocation, not a measurement.

## Checked and rejected (to avoid repeating earlier overstatements)
- JSON/schema encoding is not repeated per subscriber: `event-feed.ts:50-54` lazily renders once and reuses `encoded`; `packages/server/test/event-feed.test.ts:57-78` asserts `encodes === 1`.
- Text, reasoning, and tool-input deltas are already coalesced or not published per chunk: `publish-llm-event.ts:107,202-217,273`.
- SSE subscriber queues are bounded, not unbounded: `event-feed.ts:8,78` uses `Queue.dropping(capacity)` and fails the subscriber on the first rejected offer (`:66-68`). Capacity is counted in frames, not bytes; unit 23 already raised the byte bound as unverified.
- `isOpenCodeEvent` is O(1): `packages/protocol/src/groups/event.ts:85` is `EventManifest.isServer` (map lookup) plus a prefix test.
- `event-feed.ts:53-64` builds an `Effect.try`/`pipe`/`catch` graph per encoded event; a plain synchronous `try`/`catch` would remove it. Not in the top 5 because it is one graph per event and the catch path is cold.
- Unit 30's "one socket write per delta": the handler does emit one stream chunk per event per subscriber, but whether the HTTP layer coalesces writes was not measured here; a `Stream.groupedWithin` fix changes chunk boundaries and adds latency, so it stays unverified.
