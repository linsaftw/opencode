STATUS: done
Idle loop paths with no active rows now park on the doorbell (`dormant`) instead of the MAX_SLEEP timeout, so a process with zero automations stops re-reading the table every 30s while leader claim/release semantics stay unchanged on each wake.
Kept the bounded MAX_SLEEP wait wherever rows or event watches exist, so timer deadlines, clock jumps and lease takeovers still resolve.
Rewrote the nearby "another process" test: a direct SQLite insert is no longer polled while idle, and the row runs once a local create rings the doorbell.
Area: idle wakeups. automation.ts heartbeat (LEADER_TTL/3=20s) and 30s MAX_SLEEP loop re-read tables even with zero automations.
Task: in packages/core/src/automation.ts, skip DB work when there are no automations (rely on the doorbell), keeping leader election semantics. Add/adjust a test only if one exists nearby.
