STATUS: scouted (cycle 18: none applied; #1 ResponseFold rebuild per delta is medium risk, needs partial-message equivalence tests first)
# Unit 38 (scout, read-only on source): provider request encoding and response decoding per step
Find the LLM adapter package(s) (look under packages/ for the llm/ai package used by session/runner/llm.ts, `ai.stream`, `canCompact`). Read the request encode path for the main providers (openai responses, anthropic, openai-compatible) and the streaming response decode path (SSE/WebSocket frame -> LLMEvent). Find work per request proportional to full history that could be avoided without changing the request bytes (re-encoding all messages, repeated JSON.stringify of tools, deep clone of messages, schema validation of the whole request), and work per streamed chunk that allocates more than needed (decode schema per chunk, string concat of growing buffers, per-chunk Effect.fn setup). For each: file:line, quoted code, cost, minimal safe fix with identical bytes/events, risk. Verify every claim by quoting code; say "unverified" when unsure. Top 5 under "## Findings". Edit no other file; re-read this file at the end.


## Scope read

Read `packages/ai/src/route/client.ts` (compile/prepareRequest/streamPrepared), `route/protocol.ts`, `route/framing.ts`, `route/transport/http.ts`, `schema/events.ts` (ResponseFold), `schema/messages.ts`, `tool-history.ts`, `tool-updates.ts`, `cache-policy.ts`, `effort-updates.ts`, `protocols/shared.ts`, `protocols/openai-chat.ts`, `protocols/open-responses.ts`, `protocols/openai-responses.ts`, `protocols/anthropic-messages.ts`, `protocols/utils/tool-schema.ts`, `protocols/utils/lifecycle.ts`, and the session request source `packages/core/src/session/runner/llm.ts` + `to-llm-message.ts`. Per the brief I ran no tests, builds or git commands, and edited no file other than this one.

Two hypotheses were negative and are recorded here instead of being ranked:

- There is no whole-request schema validation on the normal request path. `compile` calls `route.body.from(resolved)` and then `route.prepareTransport(body, resolved, options)` (`route/client.ts:588-589`); `prepareTransport` in `route/client.ts:401-410` passes `encodeBody: ProviderShared.encodeJson` and the HTTP transport JSON-encodes once (`route/transport/http.ts:28-36`, `67-75`). `protocol.body.schema` is documented as validation (`route/protocol.ts:32`, `57`) but no request-path call to `body.schema` was found. Treat the schema as type-only today; unverified whether some external caller applies it.
- There is no repeated `JSON.stringify` of tool *definitions* in the OpenAI Chat/Responses lowering. Tool definitions are passed through (`openai-chat.ts:419-428`, `open-responses.ts:485-496`). The repeated serialization is of historical tool-call *arguments* (finding 4).

## Findings

### 1. Every text/reasoning/tool-argument delta rebuilds the assistant message and concatenates the growing string
`schema/events.ts:530-548`, `schema/events.ts:580-585`, `schema/events.ts:493-505`

```ts
const reduceContentDelta = (
  state: ResponseState,
  type: ContentKind,
  event: TextDelta | ReasoningDelta,
): ResponseState => {
  const started = ensureContent(state, type, event.id, event.providerMetadata)
  const parts = contentParts(started, type)
  const current = parts[event.id]
  if (!current) return started
  const text = current.text + event.text
  const providerMetadata = event.providerMetadata ?? current.providerMetadata
  return withContentParts(
    replaceContent(started, current.contentIndex, contentPart(type, text, providerMetadata)),
    type,
    {
      ...parts,
      [event.id]: { ...current, text, providerMetadata },
    },
  )
}
```

```ts
const replaceContent = (state: ResponseState, index: number, part: AssistantPart) =>
  contentWith(
    state,
    state.message.content.map((item, itemIndex) => (itemIndex === index ? part : item)),
  )
```

```ts
const reduceToolInputDelta = (state: ResponseState, event: ToolInputDelta): ResponseState => {
  const current = state.toolInputs[event.id] ?? { name: event.name, namespace: event.namespace, text: "" }
  return {
    ...state,
    toolInputs: { ...state.toolInputs, [event.id]: { ...current, text: current.text + event.text } },
  }
}
```

- Cost: `ResponseFold.reduce` runs in `stepStream` for every provider event (`llm.ts:196-205`). Each text or reasoning delta (one per token/fragment for most providers) creates a new concatenated string value, maps the current content array (`replaceContent`), and constructs a new `AssistantMessage` through `Message.assistant(content)` in `contentWith` (`events.ts:493-496`). `reduceToolInputDelta` repeats the growing concat for every streamed JSON-argument chunk of every tool call. The definite cost is one `content.map` + one Schema class construction per delta; the additional string-copy cost depends on when V8 flattens the concatenation rope, which I did not measure (unverified). On long responses and large tool arguments this is the hottest per-chunk allocation path in the decode pipeline.
- Minimal fix with identical events: keep `ContentAssembly.text` as an array of chunks (or a rope-like accumulator) and stop rebuilding `state.message` in `reduceContentDelta`/`reduceContentEnd`; materialize the final `AssistantMessage` once in `ResponseFold.complete` and once in `ResponseFold.partial` from the accumulated parts, and join/serialize at that boundary. Alternatively mutate only the one content slot in place and defer the `Message.assistant` constructor; the emitted `text-delta`/`reasoning-delta` events and their order stay exactly the same.
- Risk: `partial` is used for error payloads (`llm.ts:202-205`, `route/client.ts:620-633`), so the lazily materialized message must produce exactly today's partial message, including in-progress text and tool-call arguments. In-place mutation would break the namespace comment that earlier states must not be reused (`events.ts:696-700`) unless the array is owned by the fold. Medium risk; highest payoff on long streams.

### 2. OpenAI Chat's `step` enters an `Effect.gen` generator and allocates an events array for every SSE frame
`protocols/openai-chat.ts:1123-1135`

```ts
const step = (state: ParserState, event: OpenAIChatEvent) =>
  Effect.gen(function* () {
    if (event.error) {
      const body = ProviderShared.encodeJson(event)
      return yield* new AIError({
        reason: classifyProviderFailure({
          message: event.error.message,
          status: typeof event.error.code === "number" ? event.error.code : undefined,
          rawBody: body,
        }),
      })
    }
    const events: LLMEvent[] = []
    const choice = event.choices?.[0]
```

The common delta path does not need the generator: the only `yield*` points in the function are the error path (`1127`), `mapFinishReason` when a finish reason exists (`1146`), the two post-finish error checks (`1179`, `1262`, `1282`), and `finishTools`/`ToolStream.finishAll` on termination (`1294`, `1329`, `1345`).

- Cost: every SSE data frame, including role-only, usage-only and every content/tool-argument token delta, allocates a generator object/iterator plus the `events` array before the body runs. The result is then passed through `Stream.mapEffect` and error mapping in `streamPrepared` (`route/client.ts:447-462`). This is pure per-chunk Effect setup on the hottest decode path, separate from finding 1.
- Minimal fix with identical events: extract the body into a synchronous `stepSync(state, event): StepResult`; return `Effect.succeed(stepSync(...))` for the no-error/no-finish case, and only enter `Effect.gen` when `event.error` or a finish/terminal branch needs `yield*`. Keep the same `StepResult` values and ordering.
- Risk: the finish branches also close lifecycle blocks and can emit `step-start` before deltas; the split must preserve exactly which chunks are synchronous versus effectful. The error paths currently yield an `AIError`, so keep them on the effectful path. Medium risk.

### 3. `flattenRequest` remaps the entire message history on every request for Chat and Anthropic protocols
`protocols/shared.ts:385-414`, `route/protocol.ts:88-93`

```ts
export const flattenRequest = (request: LLMRequest): LLMRequest => {
  const all = [...request.tools, ...request.messages.flatMap((message) => toolsUpdate(message)?.add ?? [])]
  const declared = new Set(flattenTools(all).map((tool) => tool.name))
  const flatten = <Part extends ToolCallPart | ToolResultPart>(part: Part) => flattenToolName(part, declared)
  // A tool update that redefines a namespace drops the tools it leaves out, which only the namespace shows, so name
  // them as explicit removals.
  let tools = request.tools
  const messages = request.messages.map((message) => {
    if (message.role === "system" && message.tools !== undefined) {
      const next = foldTools(tools, message.tools.add, message.tools.remove)
      const remove = withdrawnTools(tools, next)
      tools = next
      return new SystemMessage({ ...message, tools: { add: flattenTools(message.tools.add), remove } })
    }
    if (message.role === "assistant") {
      const content = message.content.map((part) =>
        part.type === "tool-call" || part.type === "tool-result" ? flatten(part) : part,
      )
      return sameParts(content, message.content) ? message : new AssistantMessage({ ...message, content })
    }
    if (message.role !== "tool") return message
    const content = message.content.map(flatten)
    return sameParts(content, message.content) ? message : new ToolMessage({ ...message, content })
  })
  return {
    ...request,
    tools: flattenTools(request.tools),
    messages,
    toolChoice: flattenToolChoice(request.toolChoice, all, declared),
  }
}
```

```ts
export const make = <Body, Frame, Event, State>(
  input: Protocol<Body, Frame, Event, State>,
): Protocol<Body, Frame, Event, State> =>
  input.namespaces
    ? input
    : { ...input, body: { ...input.body, from: (request) => input.body.from(flattenRequest(request)) } }
```

- Cost: OpenAI Chat and Anthropic Messages do not set `namespaces: true`, so `Protocol.make` wraps their `body.from` and every step pays: one `messages.flatMap` to collect all tool updates, one `flattenTools` over `all` (with its `flatMap` + `new Map` + spread), one `messages.map` over the full history, one `content.map` for every assistant/tool message, plus a second `flattenTools` for the top-level tools. It runs even when there is no namespace, no `Message.tools` marker and no namespaced part, and adapters flatten again afterwards (`openai-chat.ts:884`, `anthropic-messages.ts:1025`). The request bytes are unchanged in that common case.
- Minimal fix with identical bytes: make the wrapper return `request` unchanged when a cheap guard proves there is nothing to flatten: every top-level tool is already a `ToolDefinition`, no system message has `tools`, no tool-call/tool-result part has `namespace`, and the top-level tool names are already unique. Keep the current path for any request with a namespace, marker or duplicate name. Do not remove `flattenTools` for the genuinely namespaced case.
- Risk: `flattenRequest` also deduplicates tool names and rewrites tool-choice names; the guard must include those cases or the serialized tool list could change. If a namespace can appear only through a `Message.tools` marker, missing it would change bytes. Medium risk, large saving on long Chat/Anthropic histories.

### 4. Every historical tool call's arguments are re-serialized on every request
`protocols/openai-chat.ts:463`, `protocols/open-responses.ts:571`

```ts
  return {
    id: options.toolCallID?.(part.id) ?? part.id,
    type: "function",
    function: {
      name: part.name,
      arguments: ProviderShared.encodeJson(part.input === undefined ? {} : part.input),
    },
    extra_content: decodeExtraContent(part.providerMetadata?.[options.providerMetadataKey]?.extraContent),
  }
```

```ts
  return {
    type: "function_call",
    ...(id === undefined ? {} : { id }),
    call_id: part.id,
    name: part.name,
    namespace: part.namespace,
    arguments: ProviderShared.encodeJson(part.input === undefined ? {} : part.input),
  }
```

`ProviderShared.encodeJson` is `Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))` (`utils/json.ts:3-5`), i.e. schema-encoder setup plus `JSON.stringify` for each call.

- Cost: for OpenAI Chat and OpenAI Responses routes, every assistant tool call in the *historical* conversation is passed through `encodeJson` again on every step, even though its `input` object has not changed since it was created. The work is proportional to the total size of all historical tool arguments, not to the new messages. Tool arguments can be large (file edits, search parameters, structured tool payloads), and the resulting string is then embedded in the outer request body and escaped again by the single request-level `JSON.stringify`. This is repeated work that could be avoided without changing the final bytes.
- Minimal fix with identical bytes: cache the exact `encodeJson(part.input)` string on the `ToolCallPart` (or on its `input` object) and reuse it when the same input value is lowered again. The cache must return the exact current serialization, so key it by the input object identity and only cache when the caller does not mutate it. If session history is rebuilt every step, carry the serialized arguments string through `to-llm-message.ts` instead of re-deriving it. I did not verify whether `SessionHistory.preview` reuses the same `input` object identities across steps; `to-llm-message.ts:105-112` constructs a fresh `ToolCallPart` per projection, so an identity cache may only help within one step. Verify that before choosing the layer.
- Risk: caching by mutable object identity is unsafe if a caller edits `part.input` in place after the first serialization; the current code would pick up the mutation. A session-level cached field must be invalidated whenever the stored tool input changes. Medium risk until the history identity question is measured.

### 5. Every request re-projects every tool's JSON schema even when the tool and sanitizer are unchanged
`protocols/utils/tool-schema.ts:104-108`, `route/client.ts:553-556`

```ts
// Applied once to every request before any protocol builds its body, including tools in namespaces.
const tools = (entries: LLMRequest["tools"], model: LanguageModel): LLMRequest["tools"] =>
  entries.map((tool) =>
    tool.type === "tool"
      ? new ToolDefinition({ ...tool, inputSchema: modelCompatibility(tool.inputSchema, model) })
      : { ...tool, tools: tools(tool.tools, model) },
  )
```

```ts
  const project = (tools: LLMRequest["tools"]) => ToolSchemaProjection.tools(dedupe(tools), sanitized.model)
  const updated = planToolUpdates(sanitized)
  const resolved = applyCachePolicy(
    applyEffortUpdates(mapToolUpdates({ ...updated, tools: project(updated.tools) }, project)),
  )
```

`modelCompatibility` (`tool-schema.ts:86-101`) calls `objectRoot` and then `gemini`/`moonshot` normalization, recursively rebuilding schema objects; `prepareRequest` calls `project` again for every `Message.tools` marker through `mapToolUpdates` (`route/client.ts:556`).

- Cost: for a typical session with N tool definitions, every request allocates N new `ToolDefinition` instances, N spread records and a freshly normalized input-schema tree, even though tool definitions and the model's sanitizer are stable across steps. Marker tools are projected a second time. This is proportional to total tool-schema size per step, not to history, and is a pure copy/normalization cost with no byte change.
- Minimal fix with identical bytes: memoize `modelCompatibility(inputSchema, model)` by input-schema identity and sanitizer choice (`model.compatibility?.sanitizer ?? model.route.sanitizer ?? model-name family`), using a `WeakMap` keyed by the schema object (and a per-model nested cache). When the projection is unchanged, reuse the existing `ToolDefinition`/namespace object instead of constructing a new one. Keep the current project pass for first-seen schemas and for marker tools.
- Risk: JSON schemas are treated as immutable today but the cache would not notice in-place mutation of an `inputSchema` object between steps. Also key by every input that changes normalization (sanitizer override, route sanitizer, model-id family), or a model switch could reuse another model's projection and change bytes. Medium risk.

## Additional candidates (not ranked)

- `cache-policy.ts:204-215` `countHints` walks every message and content part to count inline cache hints, but `applyCachePolicy` only uses `Math.max(0, BREAKPOINT_CAP - count)` (`cache-policy.ts:222`). Count can stop as soon as it reaches `BREAKPOINT_CAP`; replace the two `reduce` calls with loops that early-return. Bytes unchanged; low risk. Currently runs on every Anthropic/Alibaba/Bedrock-style request.
- `route/client.ts:247-256`, `563-568`, `tool-history.ts:6-45`, `65-74`: `normalizeToolHistory` builds a new normalized array and maps every tool message's content, then `restoreClasses` maps every message through `Message.make` and every tool through `ToolEntry.make` on every request. `Message.make`/`ToolEntry.make` return the same instance for already-canonical classes, but the arrays and the tool-message content arrays are still allocated. Skip the map when the array is already canonical, or fuse the normalize/restore pass.
- `route/client.ts:571-580`: `compile` builds a `references` array by `flatMap` over every message and every content part just to detect `file:` URLs, before the protocol lowering walks the same history again. Use a loop with early return and no arrays, or move the check into the media-lowering path.
- `route/client.ts:353` + `434`: `decodeEvent(route)(frame)` calls the higher-order `decodeEvent` factory inside the per-frame `Stream.mapEffect`, so a fresh decode closure is allocated for every SSE frame. Hoist `const decode = decodeEvent(route)` once per stream. The `frameError(frame)` / `frameError(frame, event)` closures at `route/client.ts:418-440` and `459` are also allocated per frame; one shared mapper with the frame as an argument would remove them.
- `route/client.ts:318-330`: `requireTerminalEvent` wraps every event in `Stream.mapEffect` and `Effect.succeed` solely to update a local `terminal` boolean and fail on post-terminal events. A synchronous `Stream.mapAccum`/tap with the same failure would remove one Effect allocation per event.
- `protocols/anthropic-messages.ts:1516-1519` and `1556-1558`: for `message_delta`, the top guard decodes `event.delta` with `decodeAnthropicStreamDelta`, discards the `Option`, and the branch decodes the same delta again. Cache the first decode (or skip the top guard for `message_delta`) to remove one schema decode per response.
- `route/client.ts:352` creates the event decoder once (`Schema.decodeUnknownEffect(protocol.stream.event)`), so there is no per-chunk schema construction. Decoding the frame itself is still one schema decode per chunk, which is required to turn provider JSON into `LLMEvent`s; no safe way to skip it was found without caching parsed frames.
- `protocols/shared.ts:313-323` `toolResultText` re-encodes every historical tool result whose `result.type` is `json`/`error`. Session projection usually stores a single text result as `text` and multiple item content as `content` (`to-llm-message.ts:114-139`), so the common tool-result path does not hit this; it is lower priority than finding 4 but the same caching idea applies if sessions start storing structured JSON results.
