STATUS: scouted

# Event fanout and client reliability

## 1. Fanout path, bounds, slow subscribers
- Each `/api/event` connection gets its own `feed.subscribe` stream merged with a 15 s heartbeat and `Stream.encodeText` (`packages/server/src/handlers/event.ts:8,19-37`). `EventFeed.layer` registers `publish` as a `Bus.listen` listener (`packages/server/src/event-feed.ts:87-92`), so fanout runs inline on the publishing session fiber inside `Bus.notify` (`packages/core/src/bus.ts:495-508`).
- Bounds are per subscriber: `Queue.dropping(4096)` (`event-feed.ts:8,37,78`). `Queue.offerUnsafe` is O(1) and never suspends, so a slow subscriber never blocks the publisher; it accumulates frames instead.
- On a full queue `offerUnsafe` returns false; that subscriber is removed and its queue failed with `SubscriberOverflowError` (`event-feed.ts:66-68`). The SSE stream then errors and the connection closes. This is the documented contract (`packages/protocol/src/groups/event.ts:69-71`): no replay, events during disconnection are lost.
- Encoding is already centralized: `frame` does one `JSON.stringify` (`event-feed.ts:29-31`), lazily on the first matching subscriber and reused for every subscriber (`event-feed.ts:51-64`). There is no per-subscriber stringify.
- Work per subscriber is a `Set.has` type check plus a map iteration and `offerUnsafe`; it is an O(N) synchronous loop with no yield (`event-feed.ts:51-69`). Filtering happens before encoding.
- The 4096 cap counts frames, not bytes. `session.text.ended`, `session.tool.input.ended` and compaction frames carry whole payloads, so one slow client can pin thousands of large strings (tens to hundreds of MB); GC pauses then hit the same loop.
- Client side: `packages/client/src/shared-events.ts:33,113-117` also buffers 4096 decoded events and fails the subscriber when full; `solid/connection.ts:181` reconnects after a fixed 1 s with no backoff or jitter. An overflow or server stall therefore makes every client re-dial on the same 1 s cadence. `shared-events.ts:140` uses `queued.shift()`, which is O(n) once a backlog exists.

## 2. Event loop and probes
- One Node listener and one Effect loop serve requests, SSE writes, sessions and SQLite (`packages/server/src/process.ts:89-98,187-194`). There is no per-request concurrency cap or separate probe thread.
- `/api/info` is answered by `dispatch`: read `Status`/`Ref`, then when ready delegate to the full HttpApi app (`process.ts:219-242`); the handler itself is cheap (`handlers/server.ts:18-30`).
- The service probe is a 5 s fetch (`packages/client/src/service-timing.ts:30`), and the service is only SIGTERMed after 4 failures over 30 s (`:39-40`). One stall is tolerated; repeated long synchronous stretches are not.
- Other synchronous work on that loop: `Bus.notify` awaits listeners sequentially (`bus.ts:497-501`); durable events run `Schema.encodeUnknownSync` inside a DB transaction plus projectors before fanout (`bus.ts:327-328,340-434`). SSE writes do honor Node `drain` (Effect Node HTTP server stream case), so a slow socket stalls only its own response.

## 3. Highest-impact safe fixes
1. Yield during fanout. In `packages/server/src/event-feed.ts:51-69`, count iterations and `yield* Effect.yieldNow()` every ~128 subscribers (snapshot the map entries only above that threshold so mid-yield joins keep current semantics). Minimal change; `/api/info` and timer fibers can run between chunks. Risk: one extra O(N) snapshot per large fanout; a snapshot queue that unsubscribed meanwhile simply fails its already-shutdown queue.
2. Bound lag by bytes, not only frames. In `event-feed.ts:8,37,78`, keep the frame cap but also fail a subscriber whose queued encoded bytes exceed ~8 MiB (carry `encoded.length` with the queue item and decrement when the stream takes it); the minimal stopgap is lowering `SubscriberCapacity` to ~512. Same "slow consumer fails its stream" contract, but memory and GC stay bounded. Risk: slow clients disconnect earlier; byte accounting under backpressure is unverified.
3. Exponential reconnect backoff with jitter. At `packages/client/src/solid/connection.ts:181`, replace the fixed `reconnectDelay` wait with `min(30_000, 1000 * 2 ** min(attempt - 1, 5))` plus small jitter; keep the forced-resync path (`:176-180`) immediate. Prevents a fleet of clients synchronizing reconnects during overload or overflow. Risk: recovery is slower after a long outage (capped at 30 s); a test expecting the second stream within 2 s still gets attempt 1 at 1 s.
