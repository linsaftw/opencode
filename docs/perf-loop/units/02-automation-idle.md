STATUS: open
Area: idle wakeups. automation.ts heartbeat (LEADER_TTL/3=20s) and 30s MAX_SLEEP loop re-read tables even with zero automations.
Task: in packages/core/src/automation.ts, skip DB work when there are no automations (rely on the doorbell), keeping leader election semantics. Add/adjust a test only if one exists nearby.
