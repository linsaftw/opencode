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
