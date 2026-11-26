STATUS: scouted (nothing applied: list/messages are page-bounded in SQL; session.context is not called on open; session.diff only matters for sessions with very many turns)
# Unit 35 (scout, read-only on source): client read endpoints that clients poll or reload often
Read packages/server/src/handlers/session.ts, packages/core/src/session/store.ts, history.ts (decodeMessageRows, decodeMessageRowsWithRefs, loadMessageRow), blob.ts hydrate, and the session list / messages / diff / todo handlers. Question: when the TUI or app opens or refreshes a session, which endpoint does work proportional to the WHOLE history (decode every row, hydrate every blob, read every part) although the client needs one page or a delta? Is pagination/cursor applied in SQL (LIMIT, seq range) or after decoding all rows? For each: file:line, quoted code, cost vs history length N, minimal fix with identical response bytes, risk. Verify every claim by quoting code; say "unverified" when unsure (earlier scouts overstated about half). Top 5 under "## Findings". Edit no other file; re-read this file at the end.

## Scope read
`packages/server/src/handlers/session.ts`, `packages/server/src/handlers/message.ts`, `packages/core/src/session/store.ts`, `packages/core/src/session/history.ts`, `packages/core/src/session/blob.ts`, `packages/core/src/session/diff.ts`, `packages/core/src/session/transfer.ts`, `packages/core/src/session/stats.ts`, plus the app/TUI read paths that decide what the client asks for (`packages/client/src/solid/data.ts`, `packages/tui/src/mini/session.shared.ts`, `packages/tui/src/mini/stream-v2.transport.ts`, `packages/tui/src/feature-plugins/system/diff-viewer.tsx`).

Answer to the brief: for a normal session open/refresh the TUI and app do **not** decode the whole history. The app sync fetches `session.get` plus one `message.list` page and `packages/client/src/solid/data.ts:94` sets `const messagePageLimit = 20`; the TUI uses `limit` 200 (`packages/tui/src/mini/session.shared.ts:7`, `packages/tui/src/mini/stream-v2.transport.ts:904`). The messages query applies the cursor range and LIMIT in SQL. The whole-history read that does exist is the separate `session.context` endpoint, which neither client calls on open. `session.diff` scans turn-boundary sequence numbers, not message bodies. `session.export` and `session.stats` read broadly but are explicit commands, not open/refresh traffic.

## Findings

### 1. `session.context` decodes the whole uncompacted window
`packages/core/src/session/store.ts:206`, `packages/core/src/session/history.ts:247-265`, `packages/server/src/handlers/session.ts:506-515`

```ts
context: Effect.fn("SessionStore.context")((sessionID) => SessionHistory.load(db, sessionID, "latest")),
```

```ts
  const compaction = yield* latestCompaction(db, sessionID, boundary, before)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const merged = yield* withParts(db, rows)
  const hashes = merged.map(rowHash)
  const stale = merged.filter((row, index) => decodeCache.get(row.id)?.hash !== hashes[index])
  const hydrated = new Map((yield* SessionBlob.hydrate(db, stale)).map((row) => [row.id, row]))
```

- Cost vs N: O(rows since the latest completed compaction), i.e. all N rows when the session has no compaction. Every row's full `data` is selected, every assistant row gets its parts read (`withParts`), every row is re-hashed (`rowHash`), and every stale row re-hydrates blob bytes and re-decodes; cached rows are still iterated and hashed. There is no LIMIT or seq range beyond the compaction boundary.
- Client relevance: verified for open/refresh as **not used**. A grep over `packages/app/src`, `packages/tui/src` and `packages/session-ui/src` found no call to `session.context`/`Session.context`; the app message sync uses `message.list` at `packages/client/src/solid/data.ts:2013`. The endpoint is still a real whole-history read for API consumers, and the built-in `home-memory` plugin calls it for up to 100 recent sessions every hour (`packages/core/src/plugin/home-memory.ts:126`).
- Minimal byte-identical fix: memoize the decoded `SessionHistory.load(..., "latest")` array per session keyed by `(compaction seq, last row seq, instruction epoch)` and return the same array; invalidate on message/part/blob/instruction writes. A client that only needs one page or a delta should call `session.messages` instead, whose response is already page-sized.
- Risk: row/part rewrites, revert deletions, compaction changes, instruction-epoch changes, and out-of-band blob deletion can stale the memo; unit 34 finding 1 documents the same invalidation problem for the runner load path. The exact set of events that can mutate a previously completed row is unverified here.

### 2. `session.diff` loads every `user` and `idle` sequence on each call
`packages/core/src/session/diff.ts:53-65`, `packages/core/src/session/diff.ts:95-97`

```ts
  const boundaries = (type: "user" | "idle") =>
    db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, type)))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(
        Effect.map((rows) => rows.map((row) => row.seq)),
        Effect.orDie,
      )
  const users = yield* boundaries("user")
  const markers = yield* boundaries("idle")
```

```ts
  const opened = markers.findLast((seq) => seq < anchor.seq) ?? -1
  const start = legacy ? anchor.seq : (users.find((seq) => seq > opened) ?? anchor.seq)
  const end = legacy ? users.find((seq) => seq > last.seq) : markers.find((seq) => seq > last.seq)
```

- Cost vs N: O(number of user messages + idle markers), which grows with session length. It selects only `seq`, not message payload, so the bytes per row are small, but it is still an unbounded `.all()` on both types per diff request. The TUI diff viewer calls it without `from`/`to` (`packages/tui/src/feature-plugins/system/diff-viewer.tsx:151`), so the whole boundary history is read to resolve the latest turn.
- Minimal byte-identical fix: replace the two arrays with targeted SQL that returns the same four values: latest idle `seq < anchor.seq` (`ORDER BY seq DESC LIMIT 1`), first user `seq > opened` (`ORDER BY seq ASC LIMIT 1`), first user `seq > last.seq` when legacy, and first idle `seq > last.seq` otherwise; detect `legacy` with `EXISTS (... type = 'idle' LIMIT 1)`. The resolved `start`/`end` sequence numbers are identical.
- Risk: the legacy branch depends on whether any idle marker exists, not on the marker after the anchor; the replacement must keep that separate existence check. Also `latestCompaction`-style JSON filters are not involved here, so the translation is mechanical, but index usage should be checked (`(session_id, type, seq)` is the intended covering index per the comment at `diff.ts:51-52`).

### 3. `session.diff` loads every `location-switched` row on each call
`packages/core/src/session/diff.ts:121-136`

```ts
  const switches = yield* db
    .select({
      seq: SessionMessageTable.seq,
      location: sql<string>`json_extract(${SessionMessageTable.data}, '$.location')`,
      previous: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.previous.location')`,
    })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "location-switched")))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  if (switches.some((row) => row.seq > first.seq && row.seq < final.seq))
    return yield* new TurnRangeError({ sessionID, field: "to", message: "Turn range spans a location change" })
  const before = switches.findLast((row) => row.seq < first.seq)?.location
  const after = switches.find((row) => row.seq > first.seq)?.previous
  const location = before ? decodeLocation(before) : after ? decodeLocation(after) : input.session.location
```

- Cost vs N: O(number of location switches in the whole session), with `json_extract` on each matching row, all to answer three questions about the current turn's sequence range. Location switches are usually rare, so this is lower impact than finding 2, but it is unbounded and repeated per diff request.
- Minimal byte-identical fix: use `LIMIT 1` / ordered queries: exists-in-range (`seq > first.seq AND seq < final.seq LIMIT 1`), latest before `first.seq` (descending, first), earliest after `first.seq` (ascending, first). The same switch rows and location strings are selected, so the returned diff and error are identical.
- Risk: `json_extract` returning NULL and ordering ties are the only semantic traps; the original takes the last before and first after in sequence order, which the ordered queries preserve. Unverified whether a session can contain enough location switches for this to matter in practice.

### 4. `session.export` decodes and hydrates every message
`packages/core/src/session/transfer.ts:61-65`, `packages/server/src/handlers/session.ts:156-166`

```ts
      export: Effect.fn("SessionTransfer.export")(function* (input) {
        const data = {
          info: yield* sessions.get(input.sessionID),
          messages: (yield* sessions.messages({ sessionID: input.sessionID, order: "asc" })).filter(isSettled),
        }
        return input.sanitize ? sanitize(data) : data
      }),
```

```ts
        "session.export",
        Effect.fn(function* (ctx) {
          return {
            data: yield* transfer
              .export({ sessionID: ctx.params.sessionID, sanitize: ctx.query.sanitize })
```

- Cost vs N: deliberately whole-history; `sessions.messages` receives no `limit`, so `store.ts:141` takes `query.all()`, then all rows are decoded and blobs hydrated. This is not a refresh path: the TUI calls it only from the copy/export commands (`packages/tui/src/routes/session/index.tsx:1343` and `:1369`).
- Minimal byte-identical fix: none for the export contract; do not page it. If the TUI copy command is ever a problem, it should stream or cap the transcript at the client, but that changes what is copied, not the endpoint bytes.
- Risk: adding a default limit here would silently produce incomplete exports.

### 5. `session.stats` without `from` scans all user/assistant rows to derive the default range
`packages/core/src/session/stats.ts:83-102`

```ts
  const to = input.to ?? Date.now()
  if (input.from !== undefined && input.from >= to) return yield* new InvalidRangeError({ from: input.from, to })
  const project = input.projectID === undefined ? sql`` : sql`AND session.project_id = ${input.projectID}`
  const from =
    input.from ??
    (yield* db
      .get<{ time: number | null }>(
        sql`
        SELECT min(message.time_created) AS time
        FROM ${SessionMessageTable} AS message
        JOIN ${SessionTable} AS session ON session.id = message.session_id
        WHERE message.type IN ('user', 'assistant')
          AND message.time_created < ${to}
          AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
          ${project}
      `,
      )
      .pipe(Effect.orDie))?.time ??
    to
```

- Cost vs N: the `min(message.time_created)` runs over every user/assistant message row before any `from` bound exists, then `windows(from, to)` builds 31-day windows. It is not a session open/refresh read; the only client call is the TUI stats command (`packages/tui/src/feature-plugins/system/stats.tsx:143`).
- Minimal byte-identical fix: require `from`/`to` for stats, or maintain a indexed minimum; if the default range must stay, the query can use an index on `time_created` if one exists. The response bytes stay the same for the same computed range.
- Risk: changing the default range would change reported totals; any index addition is outside this scout.

## Verified non-findings (checked and excluded)

- `session.list` never joins messages. `Session.list` supplies the default limit (`packages/core/src/session.ts:439`: `store.list({ ...filter, limit: input.limit ?? DefaultListLimit })`, `DefaultListLimit = 50` at `:89`), and `SessionStore` applies `query.limit(input.limit)` at `store.ts:191`. Cost is O(page of sessions), not history.
- `session.messages` pagination is in SQL. The handler defaults to 50 (`packages/server/src/handlers/message.ts:47`), the cursor resolves to a `seq` boundary (`store.ts:114-129`), and the query uses `query.limit(input.limit).all()` (`store.ts:141`). Only that page reaches `withParts`, `SessionBlob.hydrate` and `decodeMessageRows` (`store.ts:196-199`).
- `decodeMessageRows`, `decodeMessageRowsWithRefs` and `loadMessageRow` do not fetch beyond their arguments (`history.ts:199-205`, `:209-215`, `:218-232`). They are not a source of whole-history work when called with a page or one row.
- `SessionBlob.hydrate` collects hashes only from the rows it receives and loads only those blobs (`blob.ts:159-169`); it does not scan the blob table.
- `session.message` reads one row (`store.ts:145-147`) and decodes one row; no history expansion.
- There is no `session.todo` handler or route in `packages/server/src` or `packages/protocol/src` (grep for `todo` returns no handler). The TUI derives todos from loaded messages (`packages/tui/src/feature-plugins/sidebar/todo.tsx:11`), so there is no todo endpoint to fix.
- `session.diff`'s `steps` query is bounded by the resolved turn range (`diff.ts:98-116`); it reads only assistant rows between `start` and `end`, not the whole session. Findings 2 and 3 are the unbounded parts of diff.
