STATUS: scouted
# Unit 34 (scout, read-only on source): request building per step
Read packages/core/src/session/model-request.ts, runner/to-llm-message.ts, runner/llm.ts, history.ts load path. Per llm step, find work repeated over the whole history that could reuse the previous step's result without changing bytes: re-decoding rows, re-mapping every message, sorting, schema encode of unchanged messages, repeated token estimation. For each: file:line, quoted code, cost vs history length N, minimal fix that keeps the serialized request byte-identical, risk. Verify every claim by quoting the code; say "unverified" when unsure (earlier scouts overstated half their findings). Top 5 under "## Findings". Edit no other file; re-read this file at the end.

## Scope read
`packages/core/src/session/model-request.ts`, `runner/to-llm-message.ts`, `runner/llm.ts`, `session/history.ts`, plus the load helpers they call (`session/blob.ts`, `session/context.ts`, `session/compaction.ts`) and the matching projector writes where immutability is claimed.

Already present (unit 13) and verified, so not counted as findings:
- `model-request.ts:109-120` `convertedMessages` WeakMap caches `toLLMMessages` per stored message and model key.
- `model-request.ts:249-262` `imageSizes` WeakMap caches per-message image sizes.
- `model-request.ts:286-293` `schemaJson` caches `JSON.stringify` per tool schema (still `JSON.parse` per step, but that is O(tools)).
- `history.ts:176-188` `decodeMessageRowCached` skips schema decode on a hash hit. Its hashing cost is finding 1.

The runner reloads the whole window every step: `llm.ts:212` (`context.load(selected)`) and `llm.ts:256` on each retry, each reaching `context.ts:229-236` → `history.ts:333-350` → `messageEntries`.

## Findings

### 1. Every step re-reads and re-hashes every row behind the decode cache
`history.ts:173-179`, `history.ts:246-262`

```ts
const decodeCache = new Map<string, { readonly hash: number | bigint; readonly message: SessionMessage.Info }>()
const decodeCacheLimit = 4000

const decodeMessageRowCached = (row: typeof SessionMessageTable.$inferSelect) => {
  const hash = Bun.hash(JSON.stringify(row.data) + row.type)
  const hit = decodeCache.get(row.id)
  if (hit && hit.hash === hash) return Effect.succeed(hit.message)
```

```ts
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
  const decoded = yield* Effect.forEach(
    yield* SessionBlob.hydrate(db, yield* withParts(db, rows)),
    (row) => decodeMessageRowCached(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
    { concurrency: 1 },
  )
```

- Cost vs N: N rows in the uncompacted window. Every step selects every row's full `data`, then `JSON.stringify(row.data)` and `Bun.hash` each row (`history.ts:177`) even on a cache hit. That is O(total serialized bytes) CPU/allocation per step, growing with N and with tool-output size. The schema decode itself is already skipped (verified at `history.ts:179`), so do not read this as re-decoding.
- Minimal byte-identical fix: remember the last `(sessionID, boundary, compaction.seq, last seq, entries)` and read only rows with `seq > last seq`, appending to the cached entry list; hash only new or changed rows. Cached messages are the same decoded objects, so the serialized request is unchanged. When no cheap end check is possible, at least cache the per-row hash in a `WeakMap` keyed by `row.data` (helps only if the same `data` object is reused, which finding 2 currently prevents).
- Risk: projector/revert can rewrite or delete earlier rows (e.g. `projector.ts:579`, `projector.ts:588` for parts; revert deletes messages), and `InstructionState.epochStart` can change filtering (`history.ts:274-281`). The prefix cache must be dropped on revert/compaction/instruction-epoch events; unverified that completed rows are otherwise immutable.

### 2. Every step re-reads all `session_part` rows and rewrites every assistant row
`history.ts:109-133`, `history.ts:141-146`

```ts
  const partRows =
    assistantIDs.length <= DatabaseBatch.MaxBoundParameters
      ? yield* db
          .select({ message_id: SessionPartTable.message_id, data: SessionPartTable.data })
          .from(SessionPartTable)
          .where(inArray(SessionPartTable.message_id, assistantIDs))
          .orderBy(asc(SessionPartTable.message_id), asc(SessionPartTable.ordinal))
          .all()
          .pipe(Effect.orDie)
      : yield* db
          .select({ message_id: SessionPartTable.message_id, data: SessionPartTable.data })
          .from(SessionPartTable)
          .where(
            and(
              inArray(SessionPartTable.session_id, sessionIDs),
              sessionIDs.length === 1
                ? sql`${SessionPartTable.message_id} in (select ${SessionMessageTable.id} from ${SessionMessageTable} where ${SessionMessageTable.session_id} = ${sessionIDs[0]} and ${SessionMessageTable.type} = 'assistant' and ${SessionMessageTable.seq} >= ${Math.min(...rows.map((row) => row.seq))} and ${SessionMessageTable.seq} <= ${Math.max(...rows.map((row) => row.seq))})`
                : undefined,
            ),
          )
          .orderBy(asc(SessionPartTable.session_id), asc(SessionPartTable.message_id), asc(SessionPartTable.ordinal))
          .all()
          .pipe(Effect.orDie)
```

```ts
  return rows.map((row) => {
    const parts = partsByMessage.get(row.id)
    if (!parts) return row
    const inline = "content" in row.data ? row.data.content : undefined
    return { ...row, data: { ...row.data, content: Array.isArray(inline) ? [...parts, ...inline] : parts } }
  })
```

- Cost vs N: every history load reads all part payloads for all assistant messages in the window and re-merges them. O(part bytes) DB transfer plus O(assistant count) object allocation per step. `rows.map` at 141 also creates a fresh `data` object for every assistant with parts even when nothing changed, so any identity-based cache downstream (finding 1's hypothetical hash cache, the decode cache key) is defeated.
- Minimal byte-identical fix: keep `partsByMessage` per session and per assistant id, and on the next load query only parts whose `(message_id, ordinal)` exceeds the cached maximum (or whose `time_updated` changed); reuse the previous merged `data` object when no part changed. Merged content is order-identical because ordinals are unchanged.
- Risk: parts are updated and deleted, not append-only (`projector.ts:579-589`), so any part rewrite/revert must invalidate the cached message. Unverified whether a completed assistant's parts can change without a revert; if they can, the ordinal/`time_updated` check must be exact.

### 3. Every step re-reads and re-base64-encodes all media in the window
`blob.ts:106-118`, `blob.ts:124-135`

```ts
const load = Effect.fnUntraced(function* (db: DatabaseService, hashes: ReadonlySet<string>) {
  const blobs = new Map<string, string>()
  for (const batch of DatabaseBatch.batches([...hashes], 1)) {
    const found = yield* db
      .select({ hash: BlobTable.hash, data: BlobTable.data })
      .from(BlobTable)
      .where(inArray(BlobTable.hash, batch))
      .all()
      .pipe(Effect.orDie)
    for (const blob of found) blobs.set(blob.hash, view(blob.data).toString("base64"))
  }
  return blobs
})
```

```ts
export const hydrate = Effect.fnUntraced(function* (db: DatabaseService, rows: ReadonlyArray<MessageRow>) {
  const hashes = new Set<string>()
  for (const row of rows) collect(row.data, hashes)
  if (hashes.size === 0) return rows
  const blobs = yield* load(db, hashes)
  return rows.map((row) =>
    rewriteMessage(
      row,
      (file) => inlineFile(file, blobs),
      (item) => inlineToolItem(item, blobs),
    ),
  )
})
```

- Cost vs N: for any window holding attachments, every step selects every referenced blob's bytes and base64-encodes each one (`view(blob.data).toString("base64")`), then walks all rows again. O(total media bytes in the window) DB + CPU + allocation per step, even though only the tail may be new. This is the largest per-step constant when screenshots/PDFs are present.
- Minimal byte-identical fix: keep a process-level `Map<hash, base64>` (blob content is content-addressed) and consult it before the DB; only misses query and encode. The same base64 string is produced, so request bytes are unchanged.
- Risk: blob GC/deletion would leave stale bytes in the cache, changing `unavailable` placeholders. Need to evict on blob delete or cap/clear the cache; also memory grows with total media size. Whether blobs are ever deleted while a session remains live is unverified here.

### 4. Every step walks the whole transcript three times in request preparation
`model-request.ts:377-386`, `model-request.ts:206-227`, `model-request.ts:263-274`

```ts
        messages: boundImages(
          unsupportedParts(
            shaped.messages.map((message) => {
              const { metadata, ...rest } = message
              return metadata === undefined ? message : Message.make(rest)
            }),
            model.capabilities,
            model.model.provider,
          ),
        ),
```

```ts
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return message
      case "user": {
        const content = message.content.map((part) => (part.type === "media" ? media(part) : part))
        return sameParts(content, message.content) ? message : new UserMessage({ ...message, content })
      }
```

```ts
export const boundImages = (messages: LLMRequest["messages"]) => {
  const sizes = messages.flatMap(messageImageSizes)
```

- Cost vs N: `shaped.messages.map` and `messages.flatMap` traverse every message each step. For a model missing any of image/audio/video/pdf (or xAI), `unsupportedParts` does not early-return (`model-request.ts:238-243` only skips when all four are supported), so `replaceMedia` maps every message and every content part, allocating a content array per message even when nothing is replaced. That is O(N parts) per step for such models; for fully capable models it is O(N) for the two array walks. Existing per-message caches (unit 13) avoid re-scanning part contents for messages without `metadata`, but do not avoid the array traversals, and messages carrying `metadata` are recreated (`model-request.ts:146`, `:381`) so their `imageSizes`/`convertedMessages` entries miss.
- Minimal byte-identical fix: memoize `unsupportedParts` per `(message object, capabilities, provider)` (or merge it into `baseTranscript`'s per-message conversion so it shares that WeakMap cache) and keep the flattened `sizes` list incrementally from the previous step plus the new tail. `boundImages` still must replay the global cut, but only when the cut changes; if the cut is unchanged, return the previous array. Byte identity holds because these are pure functions of message objects and model.
- Risk: `boundImages`' cut depends on the ordered total, so only the per-message sizes and an unchanged-cut result can be reused. Hooks already receive and may edit these message objects in place, so reuse does not add a new mutation channel beyond the existing shared `convertedMessages` objects; unverified whether any hook relies on a fresh object per step.

### 5. Every step re-derives the prompt estimate from scratch
`llm.ts:258`, `compaction.ts:1118-1142`, `compaction.ts:991-998`

```ts
        const estimate = SessionCompaction.estimatePrompt(loaded)
```

```ts
export const estimatePrompt = (context: SessionContext.Loaded): Estimate => {
  const anchorIndex = context.messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
  const anchor = context.messages[anchorIndex]
  const base = transcript(context, context.messages.slice(Math.max(0, anchorIndex)))
  // TODO: Pass compaction history the runner has already shaped. This and `recentUserMessages` repeat the
  // runner's unsupported-media and image-budget passes; here the image budget only sees images since the anchor,
  // so image-heavy sessions can estimate high.
  const sent = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(base.messages, context.model.capabilities),
  )
```

- Cost vs N: once per step/attempt, before `compaction.compact`/`precompute` and the request (`llm.ts:258`, `:265`, `:288`). `findLastIndex` scans backward and stops at the first measured assistant, so it is O(tail) once the previous step has token counts, but O(N) before the first measured assistant. `transcript` then re-runs `baseTranscript` over the slice from the anchor and `unsupportedParts`/`boundImages` over it; if there is no anchor, `estimateRequest` (`compaction.ts:1222-1234`) token-estimates every system part, every tool schema (including `JSON.stringify(tool.inputSchema)` at 1229) and every message, O(N).
- Minimal byte-identical fix: compute the same number but reuse work — remember the last measured-anchor index and the previous estimate; when the anchor is unchanged and only a new assistant/tool tail was appended, estimate just that tail and add it (or reuse the runner's prepared tail). Keep the no-anchor path as is. Same inputs produce the same number, so `maxTokens` and serialized bytes are unchanged.
- Risk: the estimate feeds auto-compaction thresholds and the output limit, so a stale anchor after model/agent/variant switch, compaction, revert, or an in-place row update would change behavior even though the message bytes would not. Invalidate on those events. Unverified that `estimateRequest`'s no-anchor branch is frequent in practice; after the first completed step the anchor should exist.
