STATUS: done
Area: message projection
Files: packages/core/src/session/projector.ts
Task: Read the whole file. On the per-event path remove repeated JSON encode/decode, object spreads/array copies of growing collections, redundant DB reads and per-event allocations; hoist constant work; batch writes where behavior is identical.
Changed: memoized experimental.part_rows by Config entries identity; merged the message check and latest-part lookup in updateAssistantPart into one left-join read (legacy inline content still re-reads after its carry pass); moved appendAssistantPart's next-ordinal read into the INSERT as a scalar subquery; dropped an unused column from the prepare read.
Faster: the default part path drops one query per part update and one per part append, keeps a single read for message and part, and stops rescanning config documents on every event.
Risk: merged read relies on left-join null mapping for the matching part and on reloads replacing (never mutating) the config entries array; the legacy experimental.part_rows=false whole-message path is unchanged.
