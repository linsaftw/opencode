# 2026-11-27f live service idle profile (read-only)

Target: `opencode serve --service`, pid 1108514, http://127.0.0.1:49374. Nobody prompting. No signal, attach or restart.

## CPU (3 windows of ~10.3 s, /proc/<pid>/stat utime+stime, CLK_TCK=100, 12 cores)
- w1 23 ticks = 2.2% | w2 33 ticks = 3.2% | w3 43 ticks = 4.2% | total 99 ticks in 30.9 s = 3.2%
- Per thread (total): main `opencode` 65 ticks (66%), `mi-scavenger` (V8 GC) 13 (13%), `JITWorker` 12 (12%), rest about 0.
- Wakeups: voluntary ctx switches 968 in 30.9 s = 31/s; involuntary 117 = 3.8/s; about 35 wakeups/s.

## Memory and fds
- VmRSS 603.9 / 614.6 / 609.7 / 610.4 MB (+6.4 MB over 31 s, no monotonic growth). VmHWM 1013.7 MB.
- fds 207 constant across windows.

## SQLite (~/.local/share/opencode)
- opencode.db 11,168,133,120 bytes (11.2 GB), wal 14.6 MB. Other DBs: local 33 MB, token-economy 13 MB, effort-override 12.7 MB, build-all 14 MB.

## Syscalls and perf
- strace skipped: kernel.yama.ptrace_scope=1 (not a child), and attaching would stop the live service.
- perf record failed: perf_event_paranoid=4 ("Failure to open any events"). No function-level profile of the idle process was taken.

## Log (last 200 lines, 00:09:42 to 00:12:56 UTC on 2026-11-28)
- Per minute: 00:09 20 lines, 00:11 155 lines, 00:12 25 lines.
- Top messages: `watcher stopped` 57, `watcher subscribe` 43, `watcher started` 43, `event` 15, `mcp connected` 15.
- At 00:11 alone: subscribe/started/stopped 38 each.
- Restart loop: three short-lived `serve --stdio --port 0` servers (runs 2f5436b8, 7708ef62, fc95d9a4). Each started 19 file watchers and 4 MCP connects (about 3 s each), then got SIGTERM from a CLI about 30 s later while a `GET /api/event` was still open (29 to 92 s). The CLI starts that triggered them were `run --standalone`, `session delete`, and this session's `service status` probes (3 extra starts, my doing).
- Source: watcher churn at packages/core/src/filesystem/watcher.ts:105,117,131; shutdown at packages/cli/src/shutdown-deadline.ts:20 and packages/cli-rs/crates/cli/src/signals.rs:214.

## Biggest idle contributor
- Evidence: the live process is 3.2% CPU idle, and 66% of it is the main JS thread (no function-level breakdown, since perf is denied). The restart loop costs CPU and IO on other pids (watcher start/stop and MCP connects), not measured on 1108514 itself.
- Fix proposal for the next wave: (a) make `serve --stdio` children reuse the running service instead of starting a full stack (watcher and MCP init), or debounce watcher start/stop (watcher.ts:105,117); (b) fix the SIGTERM on open `/api/event` long-polls so the CLI does not kill servers mid-poll (shutdown-deadline.ts:20); (c) profile a copy on a separate port with `bun --cpu-prof` to name the main-thread hot function.
- Also: opencode.db at 11.2 GB is a likely IO and GC source; measure its growth and prune rows before the next idle run.
