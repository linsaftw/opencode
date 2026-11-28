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

## Count profile (2026-11-27, noise-independent attempt)

Method: `bun --cpu-prof --cpu-prof-interval 500 packages/cli/src/index.ts serve --stdio --port 0`, cwd `/tmp/claude-1000/prof11/cwd`, ready line read from stdout, SIGTERM after stdin closed (profile flushes). Full = hardlink copy of `~/.config/opencode` in `/tmp/claude-1000/prof11/config-full`; empty = `config-empty`. Interleaved 3 full + 3 empty. Counts via `scripts/perf/cpuprofile-count-diff.ts` (inclusive, once per sample). Mean samples per profile, delta = full - empty.

Totals: busy (non-idle) samples full 1862/1448/1326 (mean 1545, 2394 busy ms) vs empty 1508/1258/1097 (mean 1288 by count, 1845 busy ms). Busy time is the more stable measure, but the spread is still wide (full 2014-3126 ms), so the delta is about +550 ms (30%), not a stable 3.8 s.

Caveat: `--cpu-prof-interval 500` is not honoured (real spacing ~1.5-2 ms), so the table converts with 1.5 ms per sample. Sampled totals track wall time, so the count still carries load noise. Frames below are inclusive and overlap; do not add them.

| rank | delta samples | ~ms | function | what it is |
|---|---|---|---|---|
| 1 | +71.7 | ~108 | effect/internal/effect.js:407 evaluate | Effect runtime interpreting plugin/config layers (library) |
| 2 | +66.3 | ~100 | effect/internal/effect.js:453 runLoop | Effect fiber loop, same boot path (library) |
| 3 | +58.0 | ~87 | node:async_hooks runInAsyncScope | async context around Effect/plugin work (runtime) |
| 4 | +43.3 | ~65 | effect/internal/effect.js:832 | Effect success continuation (library) |
| 5 | +39.7 | ~60 | bound require | plugin/module `require` loads, context-mode and friends (Bun) |

Top in-repo deltas: `packages/cli/src/index.ts:3` import graph +26.7 samples (~40 ms); `packages/plugin/src/runtime-modules.ts:91` createLoader require +14.7; `ensurePluginRuntime` +11.7; `discoverPluginRuntimeSpecifiers` (serial Glob + `Bun.resolveSync` per file of effect and @opencode/plugin, runtime-modules.ts:25-67) +8.3; gray-matter and js-yaml frontmatter parse +8 each (library, skill/agent/command files).

Fix status: none. The top in-repo mechanism is discoverPluginRuntimeSpecifiers, about 12 ms, which is below the noise floor, so no change was made and nothing was reverted. Next step is in docs/perf/LOG.md.
