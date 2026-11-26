STATUS: done
Merge the two 30s scrub repeat loops into one fiber, halving idle timer wakeups.
Skip the map copy and expiry sweep when no attempt is due, so ticks with nothing registered/expired are cheap no-ops.
Status expiry, retention, and close behavior are unchanged.
Area: idle wakeups. packages/core/src/integration.ts scrubs every 30s (two repeat loops ~line 560).
Task: make the scrub no-op cheaply when nothing is registered/expired (check an in-memory dirty flag or next-expiry time before touching DB/FS). Only that file.
