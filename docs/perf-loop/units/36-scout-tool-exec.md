STATUS: scouted (applied cycle 17: #2 edit replaceAll chunks, #3 edit regex hoist, #4 ripgrep decoder hoist, #5 wildcard regex memo; #1 tool-input-repair schema cache deferred)
# Unit 36 (scout, read-only on source): tool execution and output handling per call
Read packages/core/src/tool (registry, bash, read, grep, edit, glob), session/runner tool execution, output truncation and the bounded-preview path (commit 75ac20ff4c). Find per-tool-call work that scales badly with output size or call count: whole-output string concatenation in loops, repeated decode of stdout, reading whole files to preview, regex recompilation per call, sync fs calls on hot paths, permission/ruleset re-evaluation parsing patterns on each call, repeated schema validation of identical tool definitions. For each: file:line, quoted code, cost scenario, minimal fix with identical output, risk. Verify every claim by quoting code; say "unverified" when unsure. Top 5 under "## Findings". Edit no other file; re-read this file at the end.

## Scope read

`packages/core/src/tool.ts`, `tool/runtime.ts`, `tool-output.ts`, `tool/plugin/{shell,read,grep,edit,glob}.ts`, `tool/read-filesystem.ts`, `tool/search.ts`, `plugin/tool-input-repair.ts`, `ripgrep.ts`, `util/wildcard.ts`, `permission/policy.ts`, `permission.ts`, and the runner call sites in `session/runner/{step,llm}.ts` and `session/model-request.ts` (definition copy path only). I did not run tests, builds, or git.

Already cached or bounded, so not counted as findings:

- Tool JSON schemas are converted once at registration (`tool.ts:58` `Data.definitions`, filled at `tool.ts:490`); `model-request.ts:286-291` already caches `JSON.stringify` per definition schema.
- Shell output is read back in a bounded tail, not the whole file: `shell.ts:906-909` computes `start = Math.max(0, size - maxBytes)` and `readRange(info.file, before, size - before)`.
- `ToolOutput.truncate` short-circuits any result that already declares `metadata.truncated` (`tool-output.ts:76`), and `ToolSearch.bounded` fetches one extra row instead of re-running the search (`tool/search.ts:22-33`).

## Findings

### 1. Every tool call re-converts the tool input schema to JSON Schema for input repair
`plugin/tool-input-repair.ts:45-57`

```ts
          const tool = event.info ?? target
          if (!tool) return
          const called = event.tool
          if (aliased) event.tool = aliased.id
          const schema = definition(tool, event.codemode).inputSchema
          if (schema.type === "object") event.input = repair(event.input, schema, schema, 0)
```

`definition` is not cached: `tool/runtime.ts:27-38` builds a fresh object and calls `inputJsonSchema`, which reaches `toJsonSchema` (`runtime.ts:187-200`) and runs `Schema.toJsonSchemaDocument`, `flattenAllOf`, `inlineLocalReferences`, and `dropDefinitionsIfResolved` on every invocation. The execute.before hook runs for every top-level and Code Mode tool call (`tool.ts:161-171`, called at `tool.ts:234` and `tool.ts:390`), so a simple `read` call pays the full schema traversal of the `read` schema, and `edit`/`shell` pay larger ones.

- Cost: fixed per call, proportional to the input schema size; worst for `edit`, `shell`, and MCP tools with large `$defs`. It is pure repeated work because the registry already built the same `ToolDefinition` at registration.
- Minimal fix with identical output: keep a `WeakMap<Tool.Info, { plain?: ToolDefinition; codemode?: ToolDefinition }>` in this plugin (or in `tool/runtime.ts`) and reuse the cached `definition(tool, event.codemode)`. Tool objects are replaced by `editor.update` rather than mutated (`tool.ts:270-282`), so identity is a safe key. The returned schema is not mutated by `repair` (it only reads it).
- Risk: if a plugin mutates `event.info.input` or `event.info.options.codemode` in place after registration, the cache would go stale; that is outside the documented registration contract. Returning the cached object itself is safe here because `repair` does not write to the schema.

### 2. `edit` `replaceAll` rebuilds the whole file once per match
`tool/plugin/edit.ts:322-327`

```ts
              const replaced = (input.replaceAll === true ? matches : matches.slice(0, 1))
                .toReversed()
                .reduce(
                  (content, match) => `${content.slice(0, match.start)}${replace(match)}${content.slice(match.end)}`,
                  source,
                )
```

- Cost: with `K` matches in an `N`-byte file, this performs `K` slices of a string that still contains nearly the whole file and concatenates them, so it copies roughly `O(K * N)` bytes and allocates `O(K)` intermediate strings. A rename of a short identifier over a multi-megabyte lockfile or generated file is the bad case. One ordinary single-match edit copies the file once, which is expected; `replaceAll` makes it quadratic.
- Minimal fix with identical output: build the output in ascending order from chunks instead of repeated full-string slices, e.g. `let cursor = 0; const parts: string[] = []; for (const match of selected) { parts.push(source.slice(cursor, match.start), replace(match)); cursor = match.end } parts.push(source.slice(cursor)); const replaced = parts.join("")`. `findOccurrences` returns ascending non-overlapping matches (`edit.ts:52-59`), and `findLineOccurrences` filters overlaps (`edit.ts:93-97`), so chunk order is identical to the reverse-reduce result.
- Risk: the selected match list must stay in ascending order and non-overlapping. `replaceAll === false` must still use only `matches[0]`; the chunk builder should select before iterating, as the current expression does. `replace(match)` reads only `source.slice(match.start, match.end)` plus the line ending, so calling it in ascending order is equivalent.

### 3. The trailing-whitespace edit fallback normalizes every line pair repeatedly with fresh regex literals
`tool/plugin/edit.ts:45-50`, `tool/plugin/edit.ts:79-86`

```ts
const normalizeForMatch = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
```

```ts
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (
      !actual.every(
        (item, lineIndex) =>
          normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex].trimEnd()),
      )
    )
      return []
```

- Cost: `findLineOccurrences` is the fallback after exact and Unicode-normalized `indexOf` both miss (`edit.ts:172-175`). For `N` file lines and an `M`-line `oldString`, the `flatMap`/`every` pair calls `normalizeForMatch` up to `2 * N * M` times. Each call allocates four `RegExp` objects (literals inside the function are evaluated per call), even though all four patterns are constant. It also re-normalizes the same `expected` line `N` times. A 100k-line file with a 20-line `oldString` is roughly 4 million normalizations for a miss that is often just a whitespace typo.
- Minimal fix with identical output: hoist the four regex literals to module constants, normalize `expected` once before the `flatMap` (`const normalizedExpected = expected.map((line) => normalizeForMatch(line.trimEnd()))`), and compare `normalizeForMatch(item.text.trimEnd()) === normalizedExpected[lineIndex]`. `normalizeForMatch` is pure, so outputs are identical.
- Risk: memory for `normalizedExpected` is `O(M)`, and per-candidate normalization still allocates; a `Map<string, string>` keyed by the trimmed line would additionally deduplicate repeated file lines at the cost of more memory. No output change.

### 4. `grep` constructs a new schema decoder for every matching line
`ripgrep.ts:253-260`

```ts
          parse: (line) =>
            decodeJsonRecord(line).pipe(
              Effect.mapError((cause) => failure("Invalid ripgrep JSON output", cause)),
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.undefined
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
```

- Cost: `decodeJsonRecord` is correctly created once (`ripgrep.ts:43`), but `Schema.decodeUnknownEffect(RawMatch)` is evaluated inside `parse` for every line that is a `match` record. That builds a parser each time. `ToolSearch.bounded` requests `limit + 1` rows, so a default grep pays this per match; a caller-supplied `limit` scales it directly. The records themselves are small, so parser setup is a meaningful fraction of per-match work.
- Minimal fix with identical output: create `const decodeMatch = Schema.decodeUnknownEffect(RawMatch)` next to `decodeJsonRecord` and call `decodeMatch(json)`. The schema and decode options are unchanged.
- Risk: none observed; schema decoders are stateless across calls.

### 5. Permission checks recompile every rule glob on every tool and every snapshot
`util/wildcard.ts:2-14`, `permission/policy.ts:115-149`, `tool.ts:325-327`

```ts
export function match(input: string, pattern: string, ignoreCase = false) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" || ignoreCase ? "si" : "s").test(normalized)
}
```

```ts
          for (const [name, tool] of data.tools) {
            if (hidden?.has(name)) continue
            if (PermissionPolicy.isActionDenied(policy, tool.options?.permission ?? name)) continue
```

- Cost: `Wildcard.match` rewrites the pattern and constructs a new `RegExp` on every call. `isActionDenied` walks `reachableEffects`, which calls `Wildcard.match(action, rule.action)` for every rule (`policy.ts:115-129`), and `Tool.snapshot` runs it once per registered tool (`tool.ts:325-327`) on every step/retry (`runner/llm.ts:235` `context.select`). Each `Permission.assert` also evaluates resources against the ruleset (`permission.ts:210-232`), so tool calls repeat the same compilation. With ~30 tools and a configured ruleset, a step performs hundreds of regex compilations for values that never change; a call performs the same per asserted resource.
- Minimal fix with identical output: memoize the compiled regexp in `wildcard.ts` keyed by `pattern + "\0" + flags`, with a small bounded map (for example 1024 entries) to avoid unbounded growth from user-provided resource patterns, and reuse it for `.test()`. Regexes have no `g`/`y` flag here, so `test` is stateless; output is byte-identical.
- Risk: an unbounded cache would leak on changing session/agent rules; bound it or clear it when config/agent permissions reload. `RegExp.lastIndex` is not used because the flags never include `g`/`y`; keep it that way.

## Additional candidates (not ranked)

- `tool-output.ts:79-87` joins text parts with repeated `joined + item.text` and `joined.endsWith("\n")`. With many text parts (MCP or Code Mode results), repeated concatenation plus `endsWith` can flatten the growing string each iteration. A `string[]` plus a `lastEndsWithNewline` boolean and one `join("\n")` would be identical, but built-ins normally emit one or two text parts, so this is lower impact than the findings above.
- `file-diff.ts:10-19` runs `diffLines(before, after)` and then `createTwoFilesPatch(before, after)` on every successful edit, which diffs the whole file twice. That is real per-edit work proportional to file size, but I did not verify that deriving `additions`/`deletions` from the patch hunks is byte-identical to `diffLines` counts, so I am not proposing it as a safe minimal fix.
- `tool/plugin/read.ts:386-392` splits the returned content again and builds a numbered-lines array before `join`. Output is capped at 50 KiB by `MAX_READ_BYTES`, so it is bounded and not a top finding.
