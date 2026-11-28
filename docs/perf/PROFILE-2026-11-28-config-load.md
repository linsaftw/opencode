# Config-load bisect of a standalone side call (2026-11-28)

Scope: read-only on live processes. Binary `~/.local/bin/opencode-token-economy`, argv `run --standalone --format json --model none/none "reply OK"`, `TE_SIDECALL=1`, tiny cwd. Isolated XDG_DATA/STATE/CACHE under `/tmp/claude-1000/prof10`. The real `~/.config/opencode` was copied to `/tmp/claude-1000/prof10/config` (never written). Variants are hardlink copies with one piece removed. CPU s = utime+stime from `/usr/bin/time` (child tree).

## Result
Machine load average was 11-15 on 12 cores during the run, so the numbers are noisy (same variant spread 6.5-10.4 s).

| variant (piece removed) | CPU s, 3 boots sequential | median |
|---|---|---|
| empty XDG_CONFIG_HOME (all user config gone) | 3.97 3.99 3.94 | 3.97 |
| full config | 8.92 7.81 7.57 | 7.81 |
| plugin entry (context-mode) | 7.78 8.24 7.79 | 7.79 (~0 delta) |
| tools/ | 6.93 6.83 6.49 | 6.83 (~1.0) |
| commands/ | 6.85 6.94 7.63 | 6.94 (~0.9) |
| agents/ | 9.89 8.54 7.23 | 8.54 (noise) |
| skills/ | 10.43 10.98 10.38 | 10.38 (noise, wrong sign) |
| mods/ | 8.52 9.28 9.88 | 9.28 (noise) |
| extensions/ | 9.71 9.01 7.85 | 9.01 (noise) |
| plugins/ | 6.86 8.83 9.13 | 8.83 (noise) |
| lean/ | 9.52 8.99 8.80 | 8.99 (noise) |
| context-mode/ (700 MB dir) | 8.07 7.76 10.05 | 7.76 (noise) |
| AGENTS.md | 9.89 10.23 10.91 | 10.23 (noise) |

Reading: user config costs about 3.8 CPU s (full 7.8 vs empty 4.0). No single piece has a delta that is stable across boots. Removing skills/ or AGENTS.md made boots slower, so per-piece deltas are below the noise floor (about ±1.5 s here). The "~2.5 s" in the earlier matrix is not reproduced in this session.

## Not done
- Step 2 profiling (`--cpu-prof`) was not run. Time ran out and the machine was too loaded for stable attribution.
- Step 3 code change: none. No provable fix; reverted nothing because nothing in the repo changed.
- Interleaved re-run (`/tmp/claude-1000/prof10/interleave.sh`) was started and stopped before completing; only 2 of 39 boots finished.

## Next
Run on an idle machine with interleaved ordering (5+ boots per variant) and `--cpu-prof` on the empty-vs-full pair only. Candidate owners to check: context-mode plugin load (plugin entry), skill source watchers (`packages/core/src/config/plugin/skill.ts:30-150`), and serial BFS in `packages/core/src/config/plugin/skill-scan.ts:11-40`.
