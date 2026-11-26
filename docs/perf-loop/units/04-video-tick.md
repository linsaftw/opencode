STATUS: rejected (regressed video-generation tests under TestClock: 2 fail vs 1 baseline; retry with a test-aware design)
Summary: video-generation.ts now returns the running-job count from `tick` and loops on it: it polls every 5s while jobs run, otherwise sleeps on a start-ring doorbell or a 60s FALLBACK scan before querying again.
Idle servers no longer scan the kv table every 5s; expired/finished records are still cleaned by the fallback scan, and leader-claim and per-job checks are unchanged while jobs exist.
`start` rings the doorbell after writing its running record, so a local submission is picked up immediately despite the longer idle interval.
Area: idle wakeups. packages/core/src/video-generation.ts runs `tick` every 5s (INTERVAL) forever, querying the DB even with no video jobs.
Task: when no job is running (track an in-memory count or ring a doorbell from `start`), skip the DB query and sleep until the next start or a long fallback (>=60s) so jobs from other processes are still noticed. Only that file; keep leader-claim semantics when jobs exist.
