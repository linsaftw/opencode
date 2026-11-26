STATUS: open
Area: idle wakeups. packages/core/src/integration.ts scrubs every 30s (two repeat loops ~line 560).
Task: make the scrub no-op cheaply when nothing is registered/expired (check an in-memory dirty flag or next-expiry time before touching DB/FS). Only that file.
