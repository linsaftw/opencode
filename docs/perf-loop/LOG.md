# perf-loop LOG
2026-11-26 SCOUT#1: compiled cpu-prof service (boot+60s idle, copy of live 405MB DB): boot 1.2 CPU-s, idle ~2%/core, RSS 146MB.
Composition (self time): Effect runLoop/anon ~35%, drizzle query build (collectSQL+escapeName+buildQuery) ~13-17%, AsyncResource/scheduleTask ~7%.
Note: build-all-2 service was hot only in the real environment (plugins/MCP/clients), not in isolation.
2026-11-26 slice1 (units 01-03): prepared drizzle statements in kv.ts + automation.ts; automation loop dormant (doorbell only) with no active rows; integration scrub merged into one 30s fiber that no-ops when nothing is due. typecheck clean; automation/kv tests: same 4 env failures as baseline. Not yet built/A-B'd (gate pending).
2026-11-26 slice2: unit 05 service-registration poll stats the file and re-reads only on change (cli service tests: same failures as baseline; one flaky test passes alone). unit 04 video tick REJECTED: 2 fail vs 1 baseline under TestClock; reverted.

## Cycle 1 (10:49-11:20)
- core session/model-request.ts, projector.ts: memoized per-message LLM conversion and tool-schema stringify; new prompt-cache-prefix test (passes). Gain unmeasured.
- server handlers/event.ts: hoisted invariant heartbeat/headers out of per-subscriber setup. Small.
- client service-timing/connection: probe timeout 2s->5s, unresponsive kill needs 4 failures over 30s, SSE stall 45s->90s. Targets the service-SIGTERM/"Event stream stalled" churn seen in logs at 13:42Z.
- REVERTED: message-updater.ts rewrite (65 type errors), inbox.ts prepared statements (transaction-handle/typing risk). Units 14 history, 15 llm-runner: workers died ("Failed to execute statement"), not done; carry to cycle 2.

## Cycle 2 (12:11-12:41)
- core config/plugin skill.ts + compatibility.ts: refresh no longer clears and recreates every native watcher; only vanished keys are pruned, and each subscription is scoped to its watch fiber (no unused subscriptions per refresh). Targets the ~820 watcher-subscribe / 627 watcher-started churn per few minutes seen in logs. Gain unmeasured.
- instruction.ts: scoped subscribe-in-fiber kept; directory-grouped entries watch REVERTED (tests pin one file-watch per file).
- REJECTED: unit 14 history cache (2x memory, deepEquals not cheaper), unit 15 llm runner (cwd cached across retries, dropped ...prepared spread).
- Scout: docs/perf-loop/units/19-scout-watchers.md. Open: global skill-root scan memoization (needs invalidation design).
- Build rule: always `--single` (linux-x64) with OPENCODE_VERSION=2.4.1 OPENCODE_CHANNEL=latest.

## Cycle 3 (13:01-13:31)
- client solid/connection.ts: event-stream reconnect now backs off exponentially (1s..30s) with jitter instead of a fixed 1s, so clients that lost an overloaded service do not re-dial in lockstep.
- Scouts: 22 persistence (top fix: single-statement event_sequence upsert in bus.ts, deferred: touches event ordering), 23 fanout, 24 skill-scan memo design (deferred: global cache correctness hinges on watcher events).
- REJECTED: unit 25 yield during SSE fanout (can reorder events across concurrent publishes).
- Observed after cycle 2 install: service 31 min up, ~17% CPU, 0 stalls/unplanned shutdowns/bind failures in log since restart.

## Cycle 4 (13:47-14:12)
- core bus.ts: the per-durable-event event_sequence SELECT is prepared once (sql.placeholder). core session/projector.ts: three fixed assistant-message SELECTs prepared once per db handle (WeakMap). Commit 35a8b126ba. Gain: removes per-event SQL building; small, not measured.
- Gate: typecheck core/server clean, 459 affected tests pass, linux-x64 build smoke-tested.
- Finding: busy_timeout=5000 with synchronous SQLite means a competing writer (e.g. --standalone run on the same DB) can block the service loop up to 5 s; reduce extra servers on the live DB, not the timeout.
- Memory pressure on the host (35 of 40 GB used by Java/browser) paused the gate briefly.

## Cycle 5 (14:23-, in progress)
- Scout 27 (runner step). Applied: to-llm-message.ts finds the last output item once instead of slice+some per reasoning item (commit 15db071242; only affects cut/errored messages, tiny gain). Typecheck core clean, 340 runner/request tests pass.
- Rejected: publish-llm-event double buffering (values is needed for the final join, pending is the reset batch); record() tool scan (short-circuits, handful of tools per step); prompt.ts structuredClone (per prompt, isolates plugin hooks).
- Held (medium risk, need design): duplicate transcript/estimate per step (llm.ts:258/267), per-step snapshot capture skip (step.ts:80, :291).
- Honest note: the remaining per-event hot-path wins are now small; the larger costs are per-step (snapshots, transcript rebuild). Not shipped yet; waiting for a bigger batch.
- Cycle 5 design review: REJECTED transcript reuse (estimate converts only anchor-onward, request converts all; per-message toLLMMessages memo from cycle 1 already shares the conversion work; reuse risks compaction triggers). REJECTED snapshot skip (start capture overlaps the provider request, off the critical path; end capture feeds the persisted Step.Ended snapshot field and the worktree can change outside the step).
- Cycle 6 review of scout 22 persistence fixes: #1 (single upsert RETURNING in bus.ts) cannot remove the initial read: seq is needed before projectors run and commit(seq) uses it, so only the prepared read (done in cycle 4) is safe. #2 (setAssistantTime json_set) and #3 (messageWrites without part re-read) change write shape inside the projector; they failed typecheck/risk review in cycle 1 and need a tests-first design with row-for-row persisted-data comparison before any edit. Not attempted blind.
- Cycle 6: unit 28 (persistence row test) worker reported done but wrote no file (verified by fd/git status). Unit marked failed; the persistence safety-net test is still to be written.
- Cycle 6 correction: unit 28 dropped. packages/core/test/session-projector.test.ts (46 tests, 122 table refs) already covers row-level projection incl. part_rows, forks, reverts and blob release; it is the safety net for any projector change. Scout-22 #3 (skip part re-read in messageWrites) REJECTED: the re-read (projector.ts:596) decides inline vs session_part storage and keeps newer-release rows compatible; it is the legacy part_rows:false path, not the default.
- Cycle 7 scout 29 (memory growth; worker run reported stale but findings were on disk and verified by reading). REJECTED: idle WebSocket sweep in model-transport.ts (sockets are kept after `completed` on purpose for checkpoint continuation, rotate at 55 min; sweeping sooner changes continuation/caching behaviour). Environment/warming/provider-discovery/plugin-update maps: tiny, bounded by historical config, not worth a change. Scout claim that no cycle-1 memos exist was wrong: they are WeakMaps (model-request.ts:109,249,286; projector.ts:319,455), GC-safe.
- Verified clean by scout: bus sessions, durable PubSubs, run-coordinator, inbox locks, event-feed subscribers, hooks callbacks, location-activity, mcp entries, watcher RcMap.
- Cycle 8 scouts 30 (fanout) and 31 (cold start). Both findings files verified on disk (31's run reported stale but wrote them).
  - 30 REJECTED: SSE JSON is already encoded once per event (event-feed.ts:53 `encoded ??=`); the per-subscriber cost is only string-to-bytes in the HTTP layer, and sharing bytes needs a string->Uint8Array interface change plus test churn for a gain proportional to a handful of clients.
  - 31 REJECTED (all five): well-known doc cache, global/system config cache, global agent/command/plugin scan cache and provider credential-file memo are all process-global caches whose correctness depends on watcher invalidation (stale until restart if an event is missed); the ancestor-walk arithmetic changes behaviour in stat-denying sandboxes. Candidate for a future design with explicit invalidation tests: well-known docs (HTTP per Location) and Azure `az` token reuse.
  - Observed, not chosen: MCP servers are connected per Location unless `pool: true`; changing the default alters connection/roots semantics and needs the user's decision.

## Cycle 9: restart root cause
- Log evidence (UTC): 17:35:04 a client (`opencode models`, callerPID 1725787) logged "Background service is unresponsive" streak=7 windowMs=30171 and SIGTERMed then SIGKILLed the 12-minute-old service (pid 1566874); all other clients logged "Event stream stalled". Trigger: a burst of ~30 `run --standalone` boots (worker pool + monitor) around 17:33-17:35 starved the service for just over 30 s (shared SQLite file, 5 s busy_timeout).
- Fix: packages/client service-timing.ts unresponsiveWindow 30 s -> 120 s (commit a30a377e6a). A hung service is still replaced, after 2 min. 60 service tests pass.
- Also seen: contender `serve --service` processes fail with "port 49374 already in use" (harmless noise).

## Cycle 10: standalone boot (scout 32)
- Applied #1: automation.ts loop skips the startup leader claim/release (a KV write + delete on the shared SQLite file) when there are no active automations and no pending last_message_id; otherwise the existing path runs unchanged. Every `run --standalone` worker paid that write on boot. Typecheck core clean; automation tests: 70 pass, 4 fail, identical 4 failing shell tests with my change stashed (baseline, environmental).
- Deferred: ModelsDev first refresh at boot (network, freshness change), migration/user_version fast path (medium risk, needs TestClock/DDL test), plugin update check fan-out on activation (network), project sweep at boot (behaviour change). Blob retention and machines read are small.
- Note: honest expectation is a small reduction in SQLite write contention per boot, not a fix for the load; the load comes from ~225 workers owned by other sessions.
- Cycle 10 shipped 15:53: installed build with automation startup-claim skip (b57178cc7a) and to-llm-message reasoning fix (15db071242). Before restart the cycle-9 service had run ~33 min under load avg 32-46 with no terminate/stall/unresponsive entries (previous service was killed at 12 min), supporting the 120 s unresponsive window.

## Cycle 11: verified scout 32's deferred items against code
- #4 plugin update checks REJECTED (scout wrong): supervisor.ts:228 forks the whole check fan-out with forkScoped, so it never blocks activation; PluginUpdate.check is cached per 24 h interval in a global node.
- #2 ModelsDev boot refresh REJECTED (scout overstated): models-dev.ts:906 returns early when stored cache metadata is within ttl, so a normal boot costs one KV read; fetches only when stale, with etag.
- #3 migration user_version fast path and #5 project sweep delay remain deferred (medium risk / behaviour change).
- Lesson: scout claims about "blocks boot" or "per boot" costs need a code check; 3 of 5 findings in scout 32 and 2 in scout 31 were wrong or overstated.
- Stability check 16:23 local: cycle-10 service at 30:00 uptime, 623 MB, 0 terminate/stall/unresponsive entries, load avg 29-65 (previous service died at 12 min under similar load).

## Cycle 12: migration fast path (scout 32 #3) REJECTED after reading migration.ts
- `CREATE TABLE IF NOT EXISTS migration` on an existing table is a parse-time no-op in SQLite (no write lock taken), and the rest is one `sqlite_master` read plus one small SELECT. A `user_version` marker would add a failure mode (forgotten bump leaves a migration unapplied) to save microseconds. Not worth the risk; no change.
- Remaining ideas are all behaviour-changing or low-yield; no code applied this cycle. Next: let the installed build gather real-use stability data.

## Cycle 13: scout 29 #1 (idle WebSocket per finished session) REJECTED
- model-transport.ts keeps the socket and `checkpoint` after `completed` on purpose: the next turn continues from the checkpoint instead of resending the whole input. Sweeping idle sockets earlier than the existing 55 min rotation would force reconnects that lose the continuation and resend full history, which costs tokens and latency (the opposite of the goal). Provider-side idle close already ends the reader and releases the channel. Cost per idle session is one socket; no change.

## Cycle 14: blob base64 cache (scout 34 #3)
- session/blob.ts `load`: process-level LRU (64 MiB cap, insertion-order eviction, entries over a quarter of the cap skipped) of hash -> base64. Every runner step hydrated the whole window, re-reading every attachment from SQLite and re-encoding it. Blobs are content-addressed and release() deletes only unreferenced blobs, so a cached encoding cannot go stale for a row that still references it. Request bytes unchanged. Typecheck clean; session-prompt/projector/long-session-perf 101 pass; prompt-cache-prefix and blob-store pass.
- Scout 34 other findings (row re-read/hash per step, part reload, unsupportedParts walks, estimatePrompt) need revert/compaction invalidation design; deferred. Scout 33 (SSE) still running or unread.
- Scout 33 (SSE) reviewed, nothing applied: prepareRoutes allocates two empty Maps and a closure per publish and EventFeed copies a 2-element entry per subscriber per event, which is noise next to the surrounding Effect/JSON work; per-subscriber encodeText matters only with many clients; compaction delta coalescing changes observable event granularity. Encoding is already once per event (test asserts encodes === 1).
- Cycle 14 shipped 16:45: installed build with the blob base64 cache (8d14f54f62). Prior service (cycle 10) ran 51 min under load avg 29-65 with no terminate/stall entries.

## Cycle 15: history decode cache hashes before blob hydration (scout 34 #1/#3)
- history.ts messageEntries: the decode-cache hash is now computed on the row after parts are merged and BEFORE blob hydration (refs are content-addressed), and only cache-miss rows go through SessionBlob.hydrate. Before: every step hydrated every row (blob read + base64 + row rewrite) and then JSON.stringify'd the base64-laden rows to hash them, so media sessions paid O(total media bytes) per step even on pure cache hits. Now hits cost one stringify of the small ref-form row.
- Known edge: a blob that was missing at first decode and appears later (same hash) would not invalidate a cached "unavailable" placeholder until eviction; blobs are written before their refs, so this needs a corrupted store.
- Verified: core typecheck clean; history/prompt/projector/long-session/cache-prefix/blob 104 pass; runner-facing suites (generate, native, compaction, tool-model-policy, warming, instructions) 349 pass. No dedicated hit-with-media test yet; add one before relying on it further.
- Cycle 15 test added: test/session-history-media-cache.test.ts loads a history with a media ref twice (second is a decode-cache hit) and asserts the same hydrated base64, then edits the row and asserts it re-decodes with the new text and still hydrated media. Passes, typecheck clean. Closes the "no dedicated hit-with-media test" gap noted above.
- Cycle 15 shipped 17:05: installed build with the history decode-cache pre-hydration hash (2217c277f4) + media cache test (ccf33a7428), on top of the blob base64 cache. Prior service ran ~19 min under falling load with no terminate/stall entries.

## Cycle 16: scout 34 #4 (unsupportedParts/boundImages walks) REJECTED
- model-request.ts:206-226 and :263-274 walk the messages with pointer comparisons and return the same objects when nothing is replaced; boundImages reads per-message sizes from a WeakMap. That is O(messages) of cheap identity work per step (microseconds at thousands of messages), dwarfed by what cycles 14-15 removed (blob reads, base64, JSON.stringify of media). Memoizing it would add a per-capability cache key for no measurable gain. #5 estimatePrompt and #2 part reload still need invalidation design.

## Cycle 17: tool-path costs (scout 36)
- util/wildcard.ts: compiled-RegExp memo (1024 entries, FIFO eviction, flags in the key). Permission checks recompiled every rule glob per tool per step (hundreds of RegExp builds per step with ~30 tools).
- ripgrep.ts: `decodeMatch` built once instead of per matching line.
- tool/plugin/edit.ts: `normalizeForMatch` regexes hoisted to constants and the expected lines normalized once; `replaceAll` builds the result in one ascending chunk pass instead of one whole-file copy per match (matches are ascending, non-overlapping, and `replace` reads only `source`).
- Deferred: tool-input-repair schema conversion per call (#1, WeakMap on tool identity; needs a test that a replaced tool object misses the cache), tool-output text concat, fileDiff double diff (byte-identity of counts unverified).
- Verified: core typecheck clean; permission, ripgrep, tool-edit/execute/patch/output/model-policy, prompt-cache-prefix 294 pass; policy, tool-registry, config, search, bus, session-store 339 pass.
- Scout 35 (read endpoints): session list and messages apply cursor and LIMIT in SQL, so open/refresh is page-bounded; the whole-history reads (session.context, export, stats) are explicit commands, not refresh traffic. session.diff rescans narrow turn-boundary rows (low impact). Nothing applied.
- Cycle 17 shipped 17:30: installed build with wildcard regex memo, ripgrep decoder hoist, edit normalizer hoist and chunked replaceAll (801bc29ae5), on top of cycles 14-15. Smoke run used a real Read tool call. Prior service ran ~24 min at low load (8-18) with no terminate/stall entries.

## Cycle 18: tool-input-repair schema cache (scout 36 #1)
- tool/runtime.ts `repairInputSchema`: WeakMap keyed by the input schema object (not the tool), used only by the read-only repair hook, replacing a per-call `definition().inputSchema` that rebuilt the full JSON Schema (toJsonSchemaDocument + flatten + inline + drop defs) for every tool call. A replaced tool with a new schema converts again; `definition()` itself is unchanged for other consumers.
- Test test/tool-repair-schema-cache.test.ts (same schema reused, different schema converts, results equal). It caught a first version that never cached: Effect schemas are functions (`typeof` "function"), not objects.
- Verified: core typecheck clean; repair, repair-integration, tool-execute, tool-registry, cache test 120 pass.

## Cycle 18b: prompt admission skips deep clone with no prompt hook (scout 37 #1)
- session/prompt.ts: `hooks.has("session","prompt")` gates structuredClone of prompt+metadata; with no hook the shallow copy (fresh arrays) is passed. `prepare` only reads it. Typecheck clean; session-prompt, session-owned 72 pass.
- Scout 37 #2 (tool-definition copy per step) deferred: identity/reference risk, needs test first. Scout 38 pending.
- Scout 38 (LLM encode/decode): negative findings (no whole-request validation, no repeated tool-def stringify). #1 ResponseFold rebuilds AssistantMessage per delta: real but medium risk (partial() used for error payloads); deferred until an equivalence test for partial/complete exists. Others unverified.

## Gate 18 (build + install)
- Typecheck core/cli/server clean; cache-hit test pass; 120+72 affected tests pass. Single-thread linux x64 build ok; `run --standalone` reached the provider (free-tier limit error, environmental). Installed (backup opencode.pre-cycle18-backup, cycle-17 backup deleted); service restarted, 527 MB at 20 s. Includes tool-input-repair schema cache and prompt clone gate.

## Cycle 19 start
- Post-restart log check: no unresponsive/stall entries; only terminate is my own explicit restart (20:43Z).
- Worker pool unavailable: commandcode "insufficient credits", hy4-flash-free 429. Unit 39 (SQL scout) manual review: indexes cover session_message (session+seq, session+type+seq, session+time+id), session_part (session,message,ordinal), session_inbox (session,delivery,seq), event (aggregate,seq). Possible redundancy: session_message_time_created_idx (global) costs a write per message; removal needs a migration and a check that no query relies on it: not done.
- ResponseFold per-delta rebuild (scout 38 #1) re-reviewed: `Message.assistant` is a `make` over a content array of typically 1-5 parts (text, reasoning, tool calls), so the per-delta cost is one small map plus one constructor, not O(response). Gain does not justify touching the fold that feeds error `partial()` payloads. Rejected unless a measured profile shows otherwise.
- Scout 34 #5 `estimatePrompt` re-reviewed: it transcribes only `messages.slice(anchorIndex)` (since the last provider-measured assistant), so per-step cost is bounded by messages since the anchor, not history. Rejected. Scout 37 #3 (tool hook event objects built before `has`) is an 8-field object per call: negligible, rejected.
- Remaining real candidates all need worker capacity or measurement: scout 37 #2 (tool definition copy per step, identity risk), scout 34 #2 (`withParts` per-step reload), global `session_message_time_created_idx` removal (migration).
- Scout 37 #2 (skip tool-definition deep copy when no session request hook): REJECTED. Built-in plugins (identity, verbosity, tool/plugin/opencode, subagent, warming, goal, optimize) always register the context/compaction/generate hooks, so the "no callbacks" path never runs in a real session; a gated skip would be dead code. A per-hook-aware copy (skip only for hooks that provably do not touch tools) would need each hook audited: not worth the identity risk.
- Scout 34 #2 `withParts` re-reviewed: already selects only (message_id, data), ordered by index, with a single session-ranged pass for large windows (earlier cycles). A cross-step parts cache would need invalidation on every part write/revert/compaction: risk outweighs the gain without a profile. Rejected for now.
- Backlog state: no safe unprofiled candidates remain; next work needs worker capacity (scouts on new areas: plugin/MCP startup, shell tool streaming, TUI client render) or a scoped profile of the installed build under load.
- Worker status: commandcode "insufficient credits", opencode free tier "Free usage limit reached" (retry ~3 h), hy4 429. `openai/gpt-6-luna` accepts work but (a) could not see a unit file in a shared checkout when the brief only gave a path, (b) with an inline brief returned only a summary with no Findings (unit 39 SQL scout still unscouted). Use inline briefs and demand Findings in the final text.
- Manual projector SQL review (unit 39 substitute): per-event reads already go through `preparedSessionReads` prepared statements; the extra `select()`/`max(ordinal)` in `prepareAssistantParts` only run for legacy inline assistant rows (`inlineCount > 0`). No new hot-path finding. Unit 39 closed as reviewed.
- Measured ResponseFold (scoped, one component, test since removed): 5000 text deltas = 41.6 ms (8.3 us/delta, includes warmup); 20000 deltas = 74 ms (3.7 us/delta). Linear, no growth with response length. At 100 tokens/s that is ~0.04% of one core, so the scout-38 #1 rewrite is confirmed not worth its partial()/error-payload risk.
- Measured SessionModelRequest.primary (scoped, one component, temporary test removed): 750-message history (300 turns, tool calls every other turn), 2 tools, 50 calls after warmup = 0.27 ms/call; serializing the result = 0.22 ms. Request building (hooks, metadata strip, unsupportedParts, boundImages) is not a hot spot for the pre-LLM step; remaining per-step cost is elsewhere (history decode, DB, provider round trip). Composition note, not an absolute target.
- Measured SessionHistory.load (scoped, temporary test removed): 750 user rows in a fresh DB, cold 22-35 ms, warm 3.2-5.1 ms/step. Warm composition: SELECT of the 750 rows with drizzle JSON parse 1.4 ms (~43%), row hashing 0.31 ms (~10%), remaining ~1.5 ms (~47%) is decode-cache lookups, ordering and Effect plumbing. Per-step history cost is a few ms against a seconds-long provider round trip: no safe >2x win left without caching rows across steps, which needs invalidation on every message write (rejected for risk). Hashing, the part cycle 15 added, is the smallest slice.
- Composition summary for a 750-message session step: request build 0.27 ms, history load ~3-5 ms, serialize 0.22 ms. Pre-LLM overhead is ~4-6 ms/step.
- Existing scoped test `long-session-perf.test.ts` already covers assistant rows with parts (cold loads): 1000 msgs 40.7 ms (select 3.0, parts 9.3, hydrate 0.1, decode 9.1); 5000 msgs 77.6 ms (select 12.7, parts 50.4, hydrate 4.4, decode 68 / sync 32.6); 20000 msgs 356 ms (select 31.7, parts 80.6, hydrate 2.8, decode 107.6). Parts ~23% and decode ~22% of a cold 1000-message load, both already optimized (narrow part select, decode cache). Blob hydration is <1-10%: no action. No new work item; my separate measurement was redundant.
- Measured the write path (scoped, temporary test removed): 200 tool steps = 1000 durable events through Bus.publish + SessionProjector on a WAL/synchronous=NORMAL file DB: 630-940 us/event (3.2-4.7 ms/step of 5 events), roughly the same for every event kind (0.6-1.1 ms). An ephemeral event (text delta) publishes in ~41 us, so deltas are not the cost; durable events are ~15x more expensive. Statement count per durable event: begin immediate, commit, event_sequence select, event-id select, event_sequence upsert, event insert (6 fixed) plus ~0.85 projector statements on average.
- Tried preparing the three unprepared fixed statements (event-id select, sequence upsert, event insert) like `sequenceQuery`: 627-662 us vs 632-942 us baseline = no measurable gain (query building is not the cost). REVERTED, not committed. The cost is the per-statement/transaction round trip (~75 us per statement incl. Effect + drizzle execute + WAL commit), so only fewer statements/transactions would help, which changes dedupe/ordering guarantees: rejected.
- Ceiling: ~1,500 durable events/s per writer; a streaming reply emits durable events per step/tool call (not per token), so this is not on a realistic hot path (a step with 1 tool = 5 events = ~3 ms vs seconds of provider time).

## Scout 40 (runner step overhead; worker gpt-6.2-sol returns usable findings with an inline brief + mandatory "## Findings")
- #1 system-prompt render per request (three `includes` + one string replace): microseconds; REJECTED.
- #2 `Context.make`/`Context.add` per selection for Code Mode: constant, small; REJECTED.
- #3 `rulesets.flat()` per selection: linear in a handful of rules; REJECTED (nonempty cache unsafe: permissions can change).
- No finding clears the bar (identical behaviour AND measurable). Worker model note: `openai/gpt-6.2-sol` works for scouting; commandcode out of credits, free tier exhausted.

## Scout 41 (memory retention; sol)
- Applied: goal plugin `compacted` marker cleared on session.deleted (goal.ts), one line, no behaviour change for live sessions.
- Rejected: Claude Agent history checkpoints (hashes only, provider-specific), compaction `precomputed` on delete (small, race risk, Location sweep already bounds it), bus `sessions` route memo (one id+ref per session, miss falls back to DB).
- Worker note: explicit `workdir` args are denied by external_directory; briefs must say "never pass workdir, use relative paths" (scouts 42/43 were blocked until then).

## Scout 43 (shell/PTY; sol)
- Applied: shell.ts readRange no longer copies Buffer chunks twice (typeof string check).
- Deferred (behaviour/timing change, needs design): PTY WebSocket unbounded outbox (needs lossless backpressure/spill), spawned shell file-stream backpressure (could change timeouts).
- Scout 42 (plugin/MCP) blocked by worker external_directory in 4 attempts; retry later.

## Cycle 19 gate
Typecheck clean, 3459 tests pass (prompt-cache-prefix + shell), single-thread build, installed (backup opencode.pre-cycle19-backup), service restarted. Smoke `run` blocked by free model usage limit (environmental). Changes: goal marker cleanup, shell page read copy. Gains negligible/memory-only.

## Scout 42 (plugin/MCP; sol, 5th attempt worked)
- #1 MCP guidance per-step tools.filter per instruction server: few servers x tens of tools, microseconds; REJECTED.
- #2 plugin activation restat/rehash: daily timer + watcher; sweep is a deliberate safety net; REJECTED.
- #3 MCP tools-changed replay: already debounced 100 ms, replay has observable effects; REJECTED.
- #4 Plan hook `lastReminder` scan: FABRICATED (no such symbol, plan.ts is 50 lines); REJECTED.
- #5 warming config resolve per request: in-memory scan, negligible; REJECTED.

## Scout 44 (TUI/client render; sol)
- Applied: grouping/session.ts hasPart scans rows from the end (live part is near the tail); boolean result identical. Gain unmeasured, estimated up to ~N-row visits saved per nonblank delta.
- Deferred: reasoning group per-ref re-resolution (needs memo design), compaction findLast miss (rare), markdown reparse (unverified).

## Cycle 20 gate (TUI hasPart)
tui typecheck clean; 107 row/grouping/data tests pass. Reasoning-group memo rejected (groups hold a handful of thoughts). Build+install deferred to bundle with next changes.

## Scout 45 (server HTTP/SSE; sol)
- #1 SSE per-subscriber UTF-8 encode (JSON already shared once): verified; ~1 us per 2 KiB frame, matters only with ~100 subscribers; fix changes EventFeed Stream<string> interface and test seams; REJECTED (revisit if many-client use appears).
- #2 double authorization on ready managed requests: deliberate two gates; REJECTED.
- #3 permission.forSession filter over pending: pending count is tiny in practice; REJECTED.

## Scout 46 (DB schema/queries; sol; some cited line numbers wrong)
- #1 session list recency index: needs migration + write cost on every time_updated bump; only matters at ~100k sessions; REJECTED for now.
- #2 title LIKE search: leading wildcard, index cannot seek; REJECTED.
- #3 messages() loads full session row for existence: one PK select per page; fix needs new store API and changes corrupt-metadata behaviour; REJECTED.
- #4 fork INSERT..SELECT: changes JSON re-encode path and resource profile; REJECTED (rare op).
- #5 stats `AS MATERIALIZED`: planner-dependent, unmeasured, rare endpoint; REJECTED.

## Scout 48 (CLI/TUI cold start; sol; all ms estimates unverified)
- #1 TUI app.tsx lists cwd via file.list only to read response.location (verified in code): swapping to location.get changes the unlistable-directory fallback semantics and older-server behaviour; needs a live TUI start check; DEFERRED to a gate with runtime verification (1-50 ms).
- #2 serial skill tree scans, #3 Storybook eager import (~0-5 ms), #4 git project resolve serial (1-8 ms cold worktree), #5 service config read twice (<3 ms): below the bar or need equivalence checks; REJECTED.

## Scout 47 (provider stream decoding, packages/ai; sol)
- Applied: openai-chat.ts tool index lookup now lazy (`tool.index ?? toolIndexByID(...) ?? ...`); pure function, identical results; full ai suite 2304 pass. Gain tiny (id-bearing first delta only).
- #1 LLM.generate event-history copy: FALSE for this checkout (appendEvent already `state.events.push`); REJECTED.
- #2 WebSocket double decode, #3 Bedrock framing recopy, #4 partial-JSON reparse (core publisher does not trigger it): provider/path-specific, need event-equivalence work; DEFERRED.

## Scout 50 (compaction; sol; line numbers did not match the checkout)
- #1 double prompt estimate per step: STALE/FALSE here (runner/llm.ts computes `estimate` once and passes it to compact and precompute); REJECTED.
- #2 summary delivery re-estimates, #3 native trigger history reload, #4 serialize-then-truncate tool output in summary split: all inside the compaction event (rare, seconds of LLM time); equivalence on malformed data unverified; REJECTED.

## Scout 49 (packages/ai request encoding; sol)
- #1 Anthropic prefix rescan per system update, #3 tool-result array spreads, #4 tool-name flatten allocs, #5 sanitizeSurrogates rebuild: each sub-millisecond at 500 messages (whole request build measured 0.27 ms/750 msgs); REJECTED.
- #2 Responses WebSocket discards a full-frame encode (opt-in transport only; ~1-3 ms at 1 MiB history): byte-equivalence work needed for full/delta frames; DEFERRED.

## Cycle 22: restart reliability (from service log evidence, not a scout)
- Observed: restarts at 21:26 and 21:47 logged "Escalating ... SIGKILL" ~5.7 s after SIGTERM although the service logged its own graceful exit (exitCode=143) at +4.3 s; teardown (3.5 s) plus process exit exceeded the client's 100 x 50 ms stop window, so clients could SIGKILL a service mid-teardown.
- Change: client defaultEnsureTiming.stopPollAttempts 100 -> 240 (12 s = server DEADLINE 10 s + 1.5 s log flush). Client typecheck clean; service tests 60 pass.
- Effect: a hung service now takes up to 12 s to be force-replaced instead of 5 s; graceful exits are no longer SIGKILLed.

## Cycle 22 follow-up: why teardown takes ~3.5 s (investigated, no change)
- 21:47 shutdown window: 59 "watcher stopped" + 71 "Sent HTTP response" lines evenly spread over 3.3 s, no gap > 0.65 s. Watchers of type entries/file use node fs.watch (sync close); only directory watchers use parcel. RcMap closes entries sequentially, but a temporary parcel unsubscribe timing test could not run (binding returned null for inotify in test env), so concurrent-close benefit is UNPROVEN; temp test removed. Needs a profile of teardown; not guessing.

## Cycle 23: SSE bytes encoded once (goal item 3: serialize once, share bytes)
- event-feed.ts: queue now carries a Frame {text, bytes?}; new `subscribeBytes` encodes UTF-8 lazily once per event and shares the Uint8Array across subscribers; `subscribe` (string) unchanged for existing callers/tests. handlers/event.ts uses subscribeBytes, pre-encodes the per-connection connected frame and the fixed heartbeat; no per-subscriber Stream.encodeText. Wire bytes identical (test asserts decode(bytes) === frame(payload) and shared identity).
- Gate: server typecheck clean; event-feed + sse-failure + process tests 15 pass; full server suite 167 pass, 1 flaky fail (machine-link "closes every link..." 5 s timeout under load; passes alone with and without the change).
- Gain: removes N-1 TextEncoder.encode calls per event for N subscribers (~1 us per 2 KiB each); matters with many clients only.

## Scout 51 (projection/persistence) - all rejected
- inbox pendingSteers loads full rows (verified real) but steer backlogs are 0-1 rows in practice and the compaction/move ordering rule is subtle: risk > gain.
- message-updater Immer array copy, projectFork JSON round trip (not per-step), Bus durable-write Drizzle statement caching (Bun already caches native statements): micro/unmeasured, deferred. No code change.

## Cycle 24 / scout 52: WebSocket reader no longer retains the opening exchange
- model-transport.ts `open` now takes `exchange.connect` (plain {url, headers, rotateAfterMs}) instead of the whole exchange; the long-lived reader/error callbacks previously captured the exchange, keeping the opening request, fallback closure and driver alive while the channel idles. Behavior identical (same url/options/errors).
- Gate: core typecheck clean; transport + checkpoint + compaction-transport + prompt-cache-prefix tests 40 pass; full core run 8040 pass / 34 fail, sampled failures identical on stashed baseline (env: GitLab, shell, config plugins).
- Rejected from scout 52: bounding queues by dropping (behavior change), evicting transport owners (loses sticky fallback), tool-run ID-only retention and bus route-prep bypass (low gain, deferred). Checkpoint slimming (#2) deferred: needs exact-comparison care.

## Scout 53 (tool execution/result handling) - all rejected
- #1 double prompt estimate: same candidate rejected earlier (estimate already shared).
- #2 double preview in tool-output.truncate: STALE - code already cuts once (afterLines/byteBoundary); tool/preview.ts does not exist.
- #3 narrow permission read models, #4 history window as scalar subquery (needs query-plan check, row-validation risk), #5 skip Effect traversal for non-image normalizeImages: small, unmeasured; deferred.

## Cycle 25 decision: stop shipping micro-edits
- Scout 53 #5 (skip normalizeImages traversal for non-image results) re-read: saves microseconds per tool call, changes returned array identity. Not applied.
- Status: every measured/verified hot-path win is shipped (cycle 23 installed). Remaining candidates are unmeasured micro-wins. Next productive step needs a scoped teardown/live profile (user permission) or a design decision (PTY backpressure, session-list index).

## Cycle 26: continuation checkpoint slimming - rejected
- open-responses-continuation.ts: the checkpoint value ({version, responseID, request, output}) is the persisted/transported checkpoint contract; `incremental` needs the full previous input for an exact element-wise canonical comparison. Storing a derived canonical form changes the checkpoint format (VERSION bump, stored-checkpoint compatibility) and the exact-compare semantics for a bounded, once-per-session retention. Risk > gain; not applied. Would need a user decision on checkpoint format migration.

## Cycle 27: session-list index - nothing to migrate
- session sql.ts already has session_v2_root_updated_idx, session_v2_root_project_path_updated_idx, project/workspace/parent/suspended indexes, plus message (session,type,seq), (session,time_created,id) and inbox (session,delivery,seq) covering indexes. The "session-list index migration" deferred item is not needed; removed from the open list. A real gap would need EXPLAIN QUERY PLAN on a synthetic DB (scoped test), not guessing.

## Cycle 28: PTY outbox backpressure - analysed, not applied
- persistent-pty.ts:173 `Queue.unbounded<Outbound>()` per socket, fed by `Queue.offerUnsafe` from onEvent; a slow client plus a flooding PTY grows memory without bound (verified). Only behavior-preserving fix is bounding by DISCONNECTING the lagging attachment (client reconnects with its cursor; replay buffer makes it mostly lossless but `truncated` can occur). That turns a slow-but-working `cat bigfile` over a slow link into a disconnect: user-visible behavior change, so it stays a user decision. Suggested policy if approved: byte cap (e.g. 16 MiB) tracked in runPtySocket's drain, close 1013 "client too slow", same shape as EventFeed overflow.

## Scout 54 (TUI streaming render/state) - no change
- #1 Markdown re-lex per delta lives in node_modules @opentui/core (third party, not our code); not patched. Shared trimmed-content memo in TextPart alone saves one trim.
- #2 reasoning-group visibility memo, #4 messageBoundaryIDs/weights on structural row insert: render-side, run per new part not per delta, unmeasured; deferred.
- #3 evicted session histories can regrow from background events (session-retention vs data.ts message.update): plausible memory leak in the TUI, needs an eviction marker at the cache boundary and TUI-level tests; deferred as a candidate for a dedicated cycle.
- Rejected claims confirmed by scout: no per-delta array spreads/sorts in client data.ts; SSE subscriber queue already capped at 4096.

## Cycle 29: scout 54 #3 (evicted TUI histories regrow) - FALSE
- Cited tui/src/context/session-retention.ts does not exist; the logic is client/src/solid/retention.ts. Its effect tracks `evicted` as `${root}:${count(id)}` per excluded session and re-evicts when background turns change a session's message count ("repopulated by background turns need eviction even when their root was already evicted"), covered by tui/test/context/session-retention.test.ts. No leak; no change.

## Cycle 30: PTY outbox cap implemented, then REVERTED
- Tried a 4096-frame cap (close 1013 "client too slow" after flushing queued frames). Typecheck and persistent-pty tests passed, but no client in this repo (tui/app/client) consumes the persistent-pty socket (cursor/attachment_id/replay_complete only appear in server, protocol and process-daemon), so reconnect-with-cursor after a 1013 close is UNVERIFIED for external clients. Not shipped; reverted. Needs a user decision or the client owner's confirmation.

## Scout 55 (server per-request HTTP path) - no change
- #1 duplicate URL parses / double session-token HMAC across dispatch+authorizationLayer: microseconds per request; touching auth ordering risks the authorization decision. Rejected.
- #2 message list: Effect.try allocated for absent cursor (trivial); the real cost (row decode + schema encode + stringify) has no behavior-identical removal per the scout itself. Rejected.
- #3 prompt submit duplicate locationErrors wrapper: saves a wrapper only, no DB read/borrow. Rejected.

## Cycle 31: synthetic watcher teardown measurement (no live data)
- Temp test (deleted) built Watcher.layer over the real nativeLayer in a Scope, subscribed 30 directory watchers and 30 file watchers in temp dirs, and timed Scope.close: directory x30 = 7.0 ms, file x30 = 1.1 ms. So closing ~60 watchers is NOT what makes shutdown take ~3.3 s; the earlier "55 ms per unsubscribe" hypothesis is refuted (caveat: the test did not independently confirm each native subscription was active, and the live service's watchers cover larger trees). Rules out the concurrent-unsubscribe change. The "watcher stopped" log lines being spread over 3.3 s means something else (event-loop stalls from HTTP/DB work during shutdown, or serialized finalizers elsewhere) paces them; finding it needs a live shutdown profile (user permission).

## Cycle 32: diagnostic for slow shutdown (no behavior change)
- util layer-node.ts trackRelease: when a layer's release (reverse-order finalizer bracket) takes >= 250 ms, log `slow layer release {layer, ms}`. Teardown.pending only names work stuck at the 10 s deadline, so a slow-but-completing shutdown (~3.3 s observed) never named its culprit. After the next restart, `rg "slow layer release" ~/.local/share/opencode/log/opencode.log` identifies what paces teardown without any live profiling. util typecheck clean, util suite 156 pass.

## Cycle 32 install (cycle-24 build)
- Installed (backup opencode.pre-cycle24-backup; cycle-23 backup deleted), restarted twice, smoke `run` returned "ok". Second restart (12 s uptime, near-empty service) logged: MCP 394 ms, Plugin 395 ms (nested in LocationServiceMap/Worktree 777 ms), process exit after ~0.8 s, SIGTERM exit 143, no SIGKILL. A long-lived busy service's restart will show the 3 s+ culprit: `rg "slow layer release" ~/.local/share/opencode/log/opencode.log`.

## Cycle 33: cache-hit test now measures the previous request's retention
- prompt-cache-prefix.test.ts compared shared-prefix bytes against the NEW request, so an appended turn (~3% of bytes) forced a 0.95 threshold. Added the goal's real criterion: the previous request (system + tools + 32 turns with tool calls) must lead the appended one for >= 99.9% of its own bytes; passes (only the closing brackets move). Test-only change, no code change.

## Scout 56 (dead code / pass-through) - no change
- The scout itself found no zero-reference declarations: only unexporting BootOptions, inlining ExecuteError / SubscriberCapacity / readAfter limit, and dropping the streamLive wrapper. No runtime effect, only diff churn in actively changing files; rejected. Correctly kept: SessionPendingTable (drizzle schema glob), latestCompaction, commitDurableEvent arg (replay uses it), mapUnavailable, SessionSystemPrompt.make.
- Conclusion: item 6 (dead code) has no meaningful yield in session/bus/server.

## Cycle 34: measured gain of the shared SSE bytes (cycle 23)
- Scoped test (deleted): one 2 KiB frame, 100 subscribers x 2000 events. Per-subscriber TextEncoder.encode: 139.6 ms total (0.7 us per encode); encode once and share: 1.5 ms. At 100 subscribers and 1000 events/s the old path costs about 70 ms of CPU per second (~7% of a core) that the shared path does not. With 1-3 subscribers (normal use) the saving is under 2 us per event: negligible. The change only matters with many concurrent SSE clients.

## Cycle 35: per-step history reload composition (measured, no change)
- Existing long-session-perf test (synthetic, in-memory DB). Cold load: 1000 msgs ~39-52 ms, 5000 ~100 ms, 20000 ~435-450 ms (~22 us/message): decode ~35-40%, parts ~22%, select ~12%, rest (row hashing, mapping) ~30%.
- Warm load (the cost every later runner step pays through decodeCache, key = row id, hash = Bun.hash(JSON.stringify(row.data)+type)): 1000 msgs 15 ms; 5000 msgs 99.5 ms and 20000 msgs 441.7 ms, i.e. NO benefit. Cause: decodeCacheLimit = 4000 with FIFO eviction and a cyclic scan of the whole window, so a window above the cap misses every row on every step (the classic cyclic-thrash cliff).
- Not changed: windows of >4000 messages are rare because compaction bounds the window by tokens (4000 messages is several hundred thousand tokens), the saving is ~2-5% of a seconds-long step, and a larger/per-session window cache trades memory for it. If it ever matters: key the cache per session with the current window replaced wholesale each load (bounded by recent sessions), not a global FIFO.

## Cycle 36: scout 57 (per-step instruction/hook work)
- Shipped: CodeModeInstructions.make memoized per inventory object (WeakMap + singleton for the removed case). Tool.snapshot already reuses one inventory until the registry changes and summarize is pure, so the per-step flatten/group/sort/format/budget pass is skipped; output identical. Codemode tests 43 pass, core typecheck clean.
- Not taken (cache-invalidation risk exceeds the gain, needs profiling first): InstructionState baseline render cache (2), Instructions diff hashing (3), credential read overlap (4), Tool.snapshot selection reuse (5), MCP/skill/reference projection reuse (6), PluginHooks.has counters (7), default prompt memo (8).
