STATUS: rejected (caches cwd across retries, drops ...prepared spread; tiny gain)
Changed: made the per-Step retry policy and session cwd lazy per Step (`Effect.cached`), removed the per-attempt prepared-request copy by destructuring the four fields the attempt keeps, and hoisted the cwd lookup out of the retry loop.
Faster: Steps without a retry no longer resolve ModelRetry or read the session cwd, and every attempt saves two object/closure allocations and one config-plus-metadata cwd read on retries, with the same request fields, event order and outputs.
Risk: the cached cwd is reused across retries of one Step, so a concurrent setCwd during a retry applies to the next Step; the cached retry policy is still created fresh per Step, preserving attempt counters.
Area: runner step
Files: packages/core/src/session/runner/llm.ts
Task: Read the whole file. Remove redundant per-step recomputation, repeated Effect service lookups and allocations on the streaming chunk path; keep stream semantics and ordering.
