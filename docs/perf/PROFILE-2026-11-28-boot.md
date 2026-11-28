# Boot CPU of `serve --stdio --port 0` (2026-11-28, boot)

Question: where does one private stdio server boot spend CPU (1133 sidecall starts in the log)?
Outcome: no source change. The boot cost I could reproduce is about 0.9 CPU s, not the 3.75-4.6 CPU s in LOG 2026-11-28.

## Method
- Source profile: `bun --cpu-prof --cpu-prof-interval 500 packages/cli/src/index.ts serve --stdio --port 0`, isolated HOME/XDG
  under /tmp/claude-1000/prof8, no user config, from a tiny git repo. Start to the ready line `{"url":...}`, then SIGINT on own pid.
  Profile: /tmp/claude-1000/prof8/prof/CPU.20261127.211751.1385281.0.001.cpuprofile (1575 busy samples at 500 us).
- Reports: `scripts/perf/cpuprofile-callers.ts --weight=count` and `scripts/perf/cpuprofile-composition.ts --weight=count`
  (/tmp/claude-1000/prof8/callers.txt, /tmp/claude-1000/prof8/comp.txt).
- Compiled binary `~/.local/bin/opencode-token-economy` (the sidecall's `selfCommand()` is `process.execPath`): ready-to-stdout
  measured from /proc/<pid>/stat (utime+stime, clock ticks at 100 Hz), 6 boots from a tiny repo:
  - no user config: 85, 68, 71 ticks (wall 452, 341, 353 ms, RSS 165 MB)
  - copy of user config (opencode.json with context-mode plugin, skills, agents, commands, mods, tools): 90, 86, 90 ticks
    (wall 537, 491, 463 ms, RSS 166 MB). Median of the 6 about 0.86 s CPU.
- The binary could not be profiled: `BUN_OPTIONS="--cpu-prof ..."` wrote no `.cpuprofile` on SIGINT.

## Repo owners, source boot, count-weighted inclusive share of 1575 samples
1. packages/plugin/src/runtime.ts:21 (`loadRuntimeModules` callback) 6.2%
2. packages/plugin/src/runtime-modules.ts:91 (`createLoader`: `require(resolved)` of effect and @opencode/plugin modules) 6.2%
3. packages/cli/src/index.ts:3 (module import of the CLI entry) 2.4%
4. packages/plugin/src/runtime.ts:12 `ensurePluginRuntime` 1.5%
5. packages/plugin/src/runtime-modules.ts:16 `loadRuntimeModules` 1.3%
6. packages/plugin/src/runtime-modules.ts:25 `discoverPluginRuntimeSpecifiers` (Bun.Glob scan and Bun.resolveSync per export) 1.2%
7. packages/core/src/tool/plugin/websearch.ts:1 (module import) 0.9%
8. packages/server/src/api.ts:1 (module import) 0.8%

Other: packages/protocol/src/api.ts:147 `makeApiFromGroup` 0.7%, packages/schema/src/schema.ts:18 0.7%,
packages/core/src/database/drizzle/sqlite-core/effect/select.ts:221 `_prepare` 0.5% (schema migration bootstrap, not a hot loop).

Composition: 42.7% of samples are native `require` (anonymous :0 under `require`). That is Bun transpiling TS sources on
a source run. The compiled binary ships pre-bundled JS, so this share does not apply to the sidecall.
Models-dev catalog (models-dev.ts:220/235, state.ts:191 in the 27c profile) does not appear in this boot: the binary wrote no models
cache file and the log has no model lines. Those owners came from a conversation window, not boot.

## Why no fix
- The largest repo owners are the plugin runtime setup (`runtime.ts:21`, `runtime-modules.ts:91`). Making them lazy changes which
  specifiers resolve at plugin load time. That is a behavior change in the plugin contract, not provably identical, and it is
  larger than the 60-line budget to prove.
- The compiled-binary boot is about 0.9 CPU s. Even removing the whole plugin runtime would not reach the 3.75-4.6 CPU s in the log.
- Unexplained gap: the log figures (375-461 ticks, 213 MB RSS) do not reproduce here. Candidates not tested: the sidecall's real
  cwd and env, the TokenEconomizer plugin config (it is not in the user opencode.json), and a network model fetch on the user's
  machine. The next unit is to run the sidecall's exact command line (`opencode run --standalone` from tokeneconomizer
  sidecall.py:389-399) under `/usr/bin/time -v` and read the child's ticks, instead of a manual serve boot.
- Better lever: the sidecall should reuse the running service (server-connection.ts:58-60) rather than boot a private server
  per call. That removes the cost entirely; it is a tokeneconomizer change, not ours.

## Before/after
No source change, so no after measurement. Boot CPU baseline (binary, median of 6): about 0.86 s, 165 MB RSS, wall 340-540 ms.
