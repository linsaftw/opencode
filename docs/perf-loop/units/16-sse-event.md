STATUS: done
Changed: hoisted the heartbeat stream and SSE response headers out of the per-subscriber handler; fanout serialization stays centralized in EventFeed (each event encoded once and shared, dropping queues bounded).
Faster: removes per-subscriber Stream.tick, header object and heartbeat closure allocation with identical frame bytes, 15s heartbeat and ordering.
Risk: the shared stream value is reused across runs; Effect streams are lazy so each subscriber still gets its own 15s tick schedule, and HttpServerResponse copies the shared headers.
Area: SSE fanout
Files: packages/server/src/handlers/event.ts
Task: Serialize each event once and share bytes across subscribers, avoid per-subscriber stringify, bound queues, keep the 15s heartbeat and ordering.
