STATUS: rejected (yield mid-fanout can reorder events across concurrent publishes; only helps >128 subscribers)
# Unit 25: yield during SSE fanout so a large subscriber loop cannot starve the event loop
File (only this): packages/server/src/event-feed.ts
Read docs/perf-loop/units/23-scout-fanout.md section 3 fix 1. The publish listener loops over all subscribers synchronously (~lines 51-69). Add a cooperative yield (Effect.yieldNow) every 128 subscribers ONLY IF the listener is already an Effect (check how Bus.listen invokes it and the types). If the listener is synchronous/non-Effect, make NO change and report that. Preserve: frame encoded once and lazily, same delivery order per subscriber, dropping/overflow semantics, subscribers that join mid-loop keep current semantics. Do not change SubscriberCapacity.

Changed: the EventFeed publish loop now snapshots subscribers only above 128 entries and yields with Effect.yieldNow() after every 128 processed.
Faster: large fanouts no longer hold the event loop for their whole synchronous loop, so probes and timer fibers can run between chunks with unchanged lazy encoding, order, and overflow semantics.
Risk: a subscriber that unsubscribes during a yield is still visited from the snapshot and merely fails its already-shutdown queue.
