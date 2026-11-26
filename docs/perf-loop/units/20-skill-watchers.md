STATUS: done
Changed: refresh now clears a per-refresh key set instead of FiberMap.clear, reuses existing watchers via onlyIfMissing, and removes only keys no longer wanted (including the missing-path removal in watchDirectory).
Faster: existing native watchers stay open across refreshes, eliminating close/reopen churn and its watcher-startup cost.
Risk: watchers are now alive during a refresh scan, so a save mid-scan can queue one extra debounced refresh; final watch set and events are unchanged.
# Unit 20: stop rebuilding skill watchers on every refresh
Files (only these): packages/core/src/config/plugin/skill.ts, packages/core/src/config/plugin/compatibility.ts
Read docs/perf-loop/units/19-scout-watchers.md section 3 fix 1. Today each refresh calls FiberMap.clear(watches) (skill.ts:151, compatibility.ts:43), tearing down and recreating every native watcher. Instead compute the new set of watch keys, FiberMap.remove only keys that disappeared and start only keys that are new (FiberMap.run with onlyIfMissing: true). Behavior must be identical: same events trigger the same refreshes, no watcher leaks, watchers still stop when the scope closes. Keep scanning/parsing unchanged.
