STATUS: done
Area: prompt admission/delivery
Files: packages/core/src/session/inbox.ts
Task: Read the whole file. Remove redundant queries and copies in enqueue/deliver, use one transaction and prepared statements where the semantics stay identical.
Changed: prepared the inbox/message lookups, insert, deletes, delivery update and list/steer/queued/compaction reads once per database with placeholders; split first admissions from reconciliation so compaction admission does not repeat the lookups it already made; read the pending compaction row directly instead of hydrating and decoding the whole inbox.
Faster: admission and every delivery boundary, cancel and delivery change now reuse compiled SQL, and manual compaction no longer scans and decodes unrelated pending items, cutting the drizzle query-build share of the hot path without changing event order.
Risk: prepared statements assume one stable database object per layer and immutable SQL shapes; the statement cache is a WeakMap so test or alternate databases prepare their own copies.
