STATUS: rejected (retains raw envelopes + decoded msgs = 2x memory; deepEquals not cheaper than hash; blob-removal risk)
Area: history load
Files: packages/core/src/session/history.ts
Task: Read the whole file. Reduce per-step reload/decode cost further: avoid re-sorting, re-grouping and re-hashing unchanged rows, share structure with the previous load, keep the existing bounded reads and row cache.
Changed: split `withParts` into `readPartRows`/`groupParts`/`mergeParts` and added a bounded per-row cache in `messageEntries` that stores each row's envelope, parts and decoded message, reusing them when `Bun.deepEquals` finds the inputs unchanged.
Faster: unchanged rows skip re-merging parts, re-hydrating media refs and re-stringifying/hashing for decode, so only the streaming tail is reprocessed and structure is shared with the previous load.
Risk: a cached row assumes its stored payload is only changed by writes that also change the compared envelope/parts (and that blob bytes stay content-addressed), so an out-of-band blob removal would keep the last hydrated message for an otherwise unchanged row.
