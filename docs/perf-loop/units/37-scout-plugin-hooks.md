STATUS: scouted (applied cycle 18: #1 prompt clone gate; #2 rejected: built-in plugins always register context hooks; #3 negligible)
# Unit 37 (scout, read-only on source): plugin hook dispatch cost on hot paths
Read packages/core/src/plugin/hooks.ts and every call site of hooks.trigger / ctx.tool.hook / ctx.session hooks on the per-message, per-step, per-tool-call and per-event paths (session/prompt.ts, runner/step.ts, runner/llm.ts, tool.ts execute.before/after, model-request.ts hooks). Find per-trigger work that does not depend on whether any plugin registered: allocating event copies, structuredClone of payloads, building Effect chains for empty callback lists, sorting or filtering callbacks on every trigger, schema decode of hook results. For each: file:line, quoted code, cost per trigger, minimal fix with identical behaviour (including with zero and many callbacks), risk. Verify every claim by quoting code; say "unverified" when unsure. Top 5 under "## Findings". Edit no other file; re-read this file at the end.


## Scope read

`packages/core/src/plugin/hooks.ts`, `packages/core/src/plugin/host.ts` (the `ctx.session.hook` / `ctx.tool.hook` / `ctx.shell.hook` / `ctx.permission.hook` registrations and `ctx.event.subscribe`), `packages/plugin/src/effect/{session,tool,registration,event}.ts`, `session/prompt.ts`, `session/model-request.ts`, `session/runner/{step,llm,retry}.ts`, `tool.ts`, `permission.ts`, `shell.ts`, `session.ts` (fork). I ran no tests, builds, or git commands and edited no source file.

What the dispatch layer actually does: `trigger` is one `Effect.fnUntraced` generator that loops a callback array and yields each callback effect; it does not build an `Effect.forEach` chain or sort/filter the array. `has` is `Effect.sync` over a `.some`. There is no per-trigger schema decode of hook results: results are the same mutable event object. There is no unconditional event-subscription dispatch; `ctx.event.subscribe` creates a bus stream only when a plugin calls it (`host.ts:273-293`). Those hypotheses are therefore negative findings, not costs. The real no-plugin costs are allocation and copying in the dispatch key lookup and at the call sites that build an event before calling `trigger`.

## Findings

### 1. Every prompt admission deep-clones the entire prompt and metadata even with zero prompt hooks
`session/prompt.ts:41-53`

```ts
  const hooks = yield* PluginHooks.Service
  const event = yield* hooks.trigger("session", "prompt", {
    sessionID: request.session.id,
    messageID: request.messageID,
    prompt: structuredClone({
      text: request.input.text,
      files: request.input.files?.slice(),
      agents: request.input.agents?.slice(),
      skills: request.input.skills?.slice(),
    }),
    metadata: structuredClone(request.input.metadata),
    delivery: request.input.delivery ?? "steer",
  })
```

- Cost: one `structuredClone` of the prompt object plus one of `metadata` per admitted user message, before any hook lookup. `structuredClone` walks the full graph; pasted file/skill/agent attachment objects and arbitrary `metadata` payloads are copied even though nearly every installation has no `session.prompt` hook. The `.slice()` calls allocate copies first and are then also cloned. This is on the `SessionPrompt.prepare` path for every prompt, not only when a plugin exists.
- Minimal fix with identical behaviour: ask the registry first, and only build the protective copy when a callback can observe it.

```ts
const active = yield* hooks.has("session", "prompt")
const event = yield* hooks.trigger("session", "prompt", {
  sessionID: request.session.id,
  messageID: request.messageID,
  prompt: active
    ? structuredClone({ text: request.input.text, files: request.input.files?.slice(), agents: request.input.agents?.slice(), skills: request.input.skills?.slice() })
    : request.input,
  metadata: active ? structuredClone(request.input.metadata) : request.input.metadata,
  delivery: request.input.delivery ?? "steer",
})
```

  With zero callbacks the returned object is the original `request.input`, which `prepare` only reads afterwards (`input.text`, `input.files`, `input.skills`, `input.agents`); it never mutates it. With one or many callbacks the clone still happens as today. `has` with no provider is consistent with `trigger` here because a prompt event has no `model` property, so `eventProviderID` returns `undefined` and provider-scoped prompt hooks are skipped by both.
- Risk: a future change that mutates `request.input` after `prepare` would now be visible to the (absent) hook path only in the zero-hook case; no current code does. If `has` is later made provider-aware for non-model events, keep the no-provider call. Low risk.

### 2. Every model step deep-copies and remaps every tool definition even when the session request hook has no callbacks
`session/model-request.ts:322-354`

```ts
      // Definitions are shared across steps and sessions, and hooks may edit schemas in place,
      // so each hook gets a deep copy.
      const given = new Map(
        tools.definitions.map((t) => [{ description: t.description, input: copySchema(t.inputSchema) }, t] as const),
      )
      ...
      const shaped = yield* shape(
        { ... },
        Object.fromEntries(Array.from(given, ([d, t]) => [t.name, d])),
      )
      ...
      const byName = new Map(tools.definitions.map((t) => [t.name, t]))
      const hooked = new Map(
        Object.entries(shaped.tools ?? {}).flatMap(([name, d]) => {
          const t = given.get(d) ?? byName.get(name)
          return t ? [[name, { ...t, description: d.description, inputSchema: d.input }] as const] : []
        }),
      )
```

  `copySchema` (`model-request.ts:284-291`) caches the JSON string but still runs `JSON.parse(cached)` once per definition per step.

- Cost: for `N` tool definitions per step, this allocates `N` outer description objects, `N` fresh parsed schema trees (`JSON.parse`), the `given` map, an `Object.fromEntries` draft map, the `byName` map, and the `hooked` map with a fresh spread per tool. `SessionModelRequest.primary` runs once per LLM step (`runner/llm.ts:274-289`), so a 30-tool session with zero `context`/`compaction`/`generate`/`title` hooks pays this full copy/remap on every step. The deep copy exists only to protect against in-place hook mutation; with no callback no one can mutate the returned draft.
- Minimal fix with identical behaviour: make `prepare` know the hook name (or an `active` boolean computed with `hooks.has("session", name, model.ref.providerID)`), and when inactive:

```ts
const given = new Map(tools.definitions.map((t) => [{ description: t.description, inputSchema: t.inputSchema }, t] as const))
// ... shape still returns its draft keyed by name ...
const hooked = new Map(tools.definitions.map((t) => [t.name, t] as const))
```

  Do not call `copySchema`; do not run the identity `given.get(d) ?? byName.get(name)` remap. The shaped request is the same object the draft was built from because `agentHook` returns the draft unchanged when no callback runs, so `hooked` can be the original definitions. With callbacks present, keep the current copy/remap path exactly; provider-scoped hooks that do not match this model also take the inactive path, which is safe because `trigger` skips them and their mutation cannot be observed.
- Risk: a plugin may register a hook lazily while a request is in flight; in that case the active decision is taken per request, as it is now for mutation. Definition identity: when inactive, `hooked` values are the shared `Tool.Info` objects rather than fresh copies; downstream reads `name`, `description`, `inputSchema` and does not mutate them, but this is the one behavioural surface to verify. Medium risk, highest payoff on tool-heavy sessions.

### 3. Every top-level and Code Mode tool call builds both `execute.before` and `execute.after` event objects before checking whether any tool hook exists
`tool.ts:161-171`, `tool.ts:189-223`

```ts
    const beforeExecute = (name: string, info: Tool.Info | undefined, input: unknown, context: Tool.Context) =>
      hooks.trigger("tool", "execute.before", {
        tool: name,
        ...(info === undefined ? {} : { info }),
        codemode: context.codemode === true,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        input,
      })
```

```ts
      const base = {
        tool: name,
        info: tool,
        codemode: context.codemode === true,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        input,
      }
      if ("failure" in execution) {
        const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
          ...base,
          status: "error",
          error: execution.failure,
        }
        yield* hooks.trigger("tool", "execute.after", afterEvent)
        return yield* afterEvent.error
      }
      const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
        ...base,
        status: "completed",
        result: {
          ...(execution.value.output === undefined ? {} : { output: execution.value.output }),
          content: execution.value.content,
          ...(execution.value.metadata === undefined ? {} : { metadata: execution.value.metadata }),
        },
      }
      yield* hooks.trigger("tool", "execute.after", afterEvent)
```

- Cost: two event object allocations (plus the nested `result` object and spread) per tool call, and two no-op `trigger` calls, regardless of registrations. `beforeExecute` is called by both the direct path (`tool.ts:234`) and the Code Mode wrapper (`tool.ts:390`); `executeTool` runs for every call on both paths. Each event spread copies 8 fields; the completed result clones `content` references into a new object. On a parallel tool burst this is per call, not per step.
- Minimal fix with identical behaviour: gate each construction on `hooks.has("tool", "execute.before")` / `hooks.has("tool", "execute.after")` (tool hooks are plain `Hooks` with no provider option, so no provider argument is needed), or add a lazy event form to `trigger` (see the cross-cutting note) and only build when the callback array is non-empty. When inactive, `beforeExecute` can return `{ tool: name, input }` (the two call sites read only `event.tool` and `event.input`) and the after path can use `execution.value` directly and return it without constructing `afterEvent`. When active, keep the current objects and ordering exactly, including the error path returning the possibly replaced `afterEvent.error`.
- Risk: callers currently use `event.tool`/`event.input`, so a slim inactive event must keep those fields and rename is impossible without a hook. The after path must still run `normalizeImages(normalizeContent(...))`; only the event object can be skipped. Low-to-medium risk because the after-result mutation is the documented plugin contract and must stay on the active path.

### 4. `trigger` and `has` allocate a template-string key and a fresh empty array on every no-op dispatch
`plugin/hooks.ts:66-67`, `plugin/hooks.ts:88-102`

```ts
    const callbacks = new Map<string, Entry[]>()
    const key = (domain: keyof Domains, name: PropertyKey) => `${domain}.${String(name)}`

    const trigger: Interface["trigger"] = Effect.fnUntraced(function* (domain, name, event) {
      for (const entry of callbacks.get(key(domain, name)) ?? []) {
        if (entry.options?.providerID !== undefined && entry.options.providerID !== eventProviderID(event)) continue
        const result: Effect.Effect<void, Failures[typeof domain][typeof name]> = entry.callback(event)
        yield* result
      }
      return event
    })

    const has: Interface["has"] = (domain, name, providerID) =>
      Effect.sync(() =>
        (callbacks.get(key(domain, name)) ?? []).some(
          (entry) => entry.options?.providerID === undefined || entry.options.providerID === providerID,
        ),
      )
```

- Cost per trigger with no registrations: `key` constructs a template string (and `String(name)`), `callbacks.get` misses, and `?? []` allocates a new empty array that is immediately discarded. `Effect.fnUntraced` also allocates the generator/Effect wrapper. `has` repeats the key and empty-array allocation and adds an `Effect.sync`. A single step performs at least the prompt, `model.request`, two `has` calls, the session request hook, plus two per tool call and one per permission assert/shell create. These are small allocations but they are on every hot path and completely avoidable.
- Minimal fix with identical behaviour: use a nested map (`Map<keyof Domains, Map<PropertyKey, Entry[]>>`) so lookup needs no string key, and read with `callbacks.get(domain)?.get(name)`; or keep the flat map but pre-share `const empty: readonly Entry[] = []` and return it instead of `[]`. Better still, expose a synchronous `active(domain, name, providerID)` check backed by the same map so call sites can avoid constructing events, and have `trigger` short-circuit before entering the generator. Registration/disposal (`hooks.ts:69-85`) would key the nested map the same way; entries and ordering are unchanged.
- Risk: the shared empty array must be typed `readonly` and never mutated; all current mutations happen through `set`/`filter` on registration, not through trigger reads. A nested map changes only internal storage, not callback order. Low risk.

### 5. Every step copies the `model.request` headers and rebuilds the request, then scans the HTTP hook table twice, with zero HTTP or model-request hooks
`session/model-request.ts:404-422`

```ts
      const baseURL = base.model.route.endpoint.baseURL
      const modelHook = yield* hooks.trigger("session", "model.request", {
        ...scope,
        baseURL,
        headers: { ...base.headers },
      })
      const route =
        modelHook.baseURL !== undefined && modelHook.baseURL !== baseURL
          ? base.model.route.with({ endpoint: { baseURL: modelHook.baseURL } })
          : base.model.route
      const request = {
        ...base,
        model: route === base.model.route ? base.model : LanguageModel.update(base.model, { route }),
        headers: Object.keys(modelHook.headers).length === 0 ? undefined : modelHook.headers,
      }
      const hasHttpHooks =
        (yield* hooks.has("session", "http.request", model.ref.providerID)) ||
        (yield* hooks.has("session", "http.response", model.ref.providerID))
```

- Cost: per step, one spread of the header record, one `trigger` effect, one `{...base}` request copy, one `Object.keys(...).length` array allocation, and two `has` scans (each with the key/empty-array cost from finding 4). With no `model.request` hook the trigger returns the event unchanged and `route === base.model.route`; the rebuilt `request` is field-for-field `base` (the copied header record has the same entries). With no HTTP hooks the two `has` scans still run. This is on the same per-step path as finding 2 and is pure overhead in the default configuration.
- Minimal fix with identical behaviour: compute `const modelRequestActive = yield* hooks.has("session", "model.request", model.ref.providerID)` and keep `request = base` when inactive; compute one combined HTTP flag (for example add `hooks.any(domain, names, providerID)` or short-circuit the second `has` only when the first is false, as today, but skip both when both are absent is not observable) and skip the `model.request` event construction entirely when inactive. When active, keep the header copy because a hook is allowed to mutate it. The existing `hasHttpHooks` short-circuit already avoids the second `has` when the first is true; the remaining cost is the all-absent case, which is the common one.
- Risk: `request` currently always has a copied `headers` object. Returning `base` directly changes that reference. No code in the prepare path mutates `request.headers` after this point (`ai.request` built `base` and already owns its headers), but a provider driver that mutates the passed request headers would now affect `base`; mark this for verification before applying. If uncomfortable, keep `{ ...base, headers: { ...base.headers } }` and only skip the trigger/has work.

## Additional candidates (not ranked)

- `session/runner/llm.ts:182-192` builds `{ sessionID, background }` and calls `hooks.trigger("session", "experimental.idle", ...)` on every idle boundary. The object is cheap, but `SessionBackground.outstanding` is computed regardless; no per-message copy. Low.
- `permission.ts:208-222` builds the evaluate event (including the `row(input.source)` parent lookup) for every permission assertion, then triggers. Cheap per assert relative to policy evaluation, but permission asserts are per tool call and per resource; the same `has` gate applies.
- `shell.ts:975-988` builds `invocation` and triggers `shell.create.before` for every shell creation; the object is small and the env spread is needed anyway. Low.
- `session.ts:402-409` triggers `session.fork` with a trivial `{ sessionID }`; one per fork. Low.
- `session/model-request.ts:426-448` constructs a `Response` and converts the response stream to a readable stream *before* `http.response` runs. If only `http.request` is registered, `hasHttpHooks` is true, but the response-side `Stream.toReadableStreamEffect` and `new Response` still happen for every HTTP request and no callback consumes the result. This depends on a plugin being registered, so it is outside the strict "zero plugins" question, but splitting the request and response flags would avoid it. Verified by the code above; the response trigger is unconditional inside the `hasHttpHooks` branch.
- `plugin/hooks.ts:90` calls `eventProviderID(event)` once per provider-scoped entry. With many provider hooks, the same `event.model.providerID` guard is re-read repeatedly. Compute it once lazily when the first `options.providerID` entry is seen; behaviour is identical because the event is not mutated before the loop. Low for typical registration counts.
- `plugin/hooks.ts` has no per-trigger schema decode or callback sorting/filtering. The loop is insertion-ordered and lazy; that hypothesis is negative.
