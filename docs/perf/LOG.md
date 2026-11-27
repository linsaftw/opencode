# CPU composition log

## 2026-11-27 baseline (read-only sampling, no processes touched)
- Shared service (pid 106564, 17h): ~0.9% avg CPU, 913 MB RSS. Of its CPU time ~68% is the mimalloc
  scavenger thread (`mi-scav`), under heavy system memory pressure (30 GB swap, 35% iowait).
- Real cost: 49 live `opencode serve --stdio --port 0` backends (~400 MB each, ~15 CPU-s startup each).
  All are children of `opencode run --standalone ...` launched by claude-opencode-mcp per delegated task.
- Fix landed (claude-opencode-mcp 9588d09): runs and pool workers attach to the shared service;
  agent profiles are materialized in the global agents dir (service hot-loads them).
  Verified: deepseek-coder run on the shared service, serve --stdio count 49 -> 49 (no new backend).
- Next: purge delay / allocator settings for the service, startup cost of `serve --stdio`, per-token projection share.
