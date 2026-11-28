# `opencode run --standalone` CPU (2026-11-28)

Question: the sidecall costs ~2.5 CPU s more than a bare serve boot. Where is it?
Outcome: no source change. The extra cost is in the serve child, not the parent `run` process.

## Method
- Binary `~/.local/bin/opencode-token-economy` (v2.4.1), argv `run --standalone --format json "reply OK"`, empty XDG under /tmp/claude-1000/prof12/base/runN.
- Provider: fake OpenAI server (scripts/perf/fake-openai-server.ts, port 49881) reached through `provider.opencode.options.baseURL`; HTTPS/HTTP proxy set to a closed port so nothing reaches the network.
- Note: `--model openai/gpt-4o-mini` returned provider.no-route in this env, so the default model is used. The fake script emits 2 glob tool calls, so each run is 3 LLM steps, not one reply.
- CPU: `/usr/bin/time` for the tree total; /proc polling of the run process and its serve child (utime+stime ticks).

## Result (n=5, CPU s)
| process | runs (s) | median |
|---|---|---|
| run (parent CLI) | 0.32, 0.35, 0.36, 0.37, 0.34 | 0.35 |
| serve --stdio (child) | 4.77, 4.77, 5.08, 5.09, 5.30 | 5.09 |
| tree (time) | 5.14, 5.43, 5.45, 5.48, 5.70 | 5.45 |

Wall 3.7-4.5 s. CPU above wall means Bun threads run in parallel (GC/JIT).

Phases (run1, from stdout timestamps): first step at 0 ms, first token +120 ms, steps finish +166, +353, +542 ms. The ~3.9 s before and after these events (boot, catalog, shutdown) is not timestamped in stdout, so it is not split further.

## Source profiles (guarded run, BUN_OPTIONS --cpu-prof, 500 us requested; real spacing ~1.5-2 ms)
- serve child: busy 10.1 s. Composition: Effect fiber/layer 33%, SSE/event 2%, sqlite 3%, JSON 3%, other 57%.
- run parent: busy 12.6 s. Composition: SSE/event 7%, other 89%. The parent is small in the compiled run (0.35 s), so source-run numbers are inflated by transpilation.
- Child repo owners (inclusive, count-weighted): models catalog Schema decode, `packages/core/src/models-dev.ts` via effect `SchemaAST`/`SchemaParser` (~9.5%); `packages/core/src/provider.ts:401` structuredClone of provider info (0.9%); `provider.ts:426` update (0.5%); `models-dev.ts:451` `released` (0.2%). The wrapper-based owner list in cpuprofile-callers.ts was empty for these profiles, so this list is from the self/inclusive rows, not the full top 8.
- Parent owners: no repo-owned frame reached the top 8 in the shares output; the SSE/event share is the only repo-visible part.

## Why no fix
The largest child owner is the model catalog decode on every serve start (models-dev.ts), which changes the catalog contract. Not provable in 45 min with a 5-run median. No src edit, nothing reverted.

## Next unit
A/B of the catalog decode (skip unused providers or cache the decoded snapshot by version) with 5-run medians, checked by models-dev tests.
