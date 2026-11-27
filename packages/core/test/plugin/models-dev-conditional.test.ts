import { afterAll, describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"
import { ModelsDev } from "@opencode/core/models-dev"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Hash } from "@opencode/util/hash"
import { testEffect } from "../lib/effect"

const catalog = (name: string) =>
  JSON.stringify({
    p: {
      id: "p",
      name: "P",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        m: {
          id: "m",
          name,
          release_date: "2024-01-01",
          attachment: false,
          reasoning: false,
          tool_call: false,
          limit: { context: 1000, output: 100 },
        },
      },
    },
  })

// Local models.dev stand-in: serves one body/ETag pair and answers 304 when If-None-Match matches.
const state = { etag: '"v1"', body: catalog("Model v1") }
const seen: (string | null)[] = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const inm = req.headers.get("if-none-match")
    seen.push(inm)
    if (inm === state.etag) return new Response(null, { status: 304, headers: { etag: state.etag } })
    return new Response(state.body, { headers: { "content-type": "application/json", etag: state.etag } })
  },
})
afterAll(() => server.stop(true))

const url = `http://127.0.0.1:${server.port}`
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ModelsDev.node, KV.node]), [
    ModelsDev.node.replace(ModelsDev.configured({ url })),
  ]),
)

// Rewrites the stored entry with an old updatedAt, so the next periodic refresh is past the TTL.
const age = (body: string, etag: string) =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    yield* kv.set(`models-dev:catalog:${Hash.fast(url)}`, {
      updatedAt: Date.now() - 2 * 60 * 60 * 1000,
      etag,
      body,
    })
  })

describe("ModelsDev conditional refresh", () => {
  it.live("does not fetch within the TTL and forced refresh is unconditional", () =>
    Effect.gen(function* () {
      const svc = yield* ModelsDev.Service
      yield* svc.get()
      yield* svc.refresh()
      const boot = seen.length
      for (let i = 0; i < 12; i++) yield* svc.refresh()
      expect(boot).toBeLessThanOrEqual(2)
      expect(seen.length).toBe(boot)
      yield* svc.refresh(true)
      expect(seen.length).toBe(boot + 1)
      expect(seen.at(-1)).toBeNull()
    }),
  )

  it.live("aged cache sends If-None-Match; 304 keeps models; a changed ETag replaces them", () =>
    Effect.gen(function* () {
      state.etag = '"v1"'
      state.body = catalog("Model v1")
      const svc = yield* ModelsDev.Service
      yield* svc.refresh(true)
      const before = JSON.stringify(yield* svc.get())
      expect(before).toContain("Model v1")

      yield* age(state.body, state.etag)
      const count = seen.length
      yield* svc.refresh()
      expect(seen.length).toBe(count + 1)
      expect(seen.at(-1)).toBe('"v1"')
      expect(JSON.stringify(yield* svc.get())).toBe(before)

      state.etag = '"v2"'
      state.body = catalog("Model v2")
      yield* age(catalog("Model v1"), '"v1"')
      yield* svc.refresh()
      expect(seen.at(-1)).toBe('"v1"')
      expect(JSON.stringify(yield* svc.get())).toContain("Model v2")
    }),
  )
})
