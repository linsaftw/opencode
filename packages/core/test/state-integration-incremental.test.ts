import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { Integration } from "@opencode/core/integration"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Credential } from "@opencode/core/credential"
import { Bus } from "@opencode/core/bus"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, Bus.node])))

const ids = ["openai", "anthropic", "google"].map((id) => Integration.ID.make(id))
const methods = ["chatgpt", "console"].map((id) => Integration.MethodID.make(id))
const authorize = () =>
  Effect.succeed({
    mode: "auto" as const,
    url: "https://example.com/authorize",
    instructions: "Sign in",
    callback: Effect.never,
  })

// Linear congruential generator: small seeded PRNG so every sequence is reproducible.
const random = (seed: number) => {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

describe("Integration State incremental rebuild", () => {
  it.effect("matches a full replay across 200 seeded sequences of registrations, method edits, removals and reads", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      let reads = 0
      let scopedWrites = 0
      for (let seed = 1; seed <= 200; seed++) {
        const next = random(seed)
        const scopes: Scope.Closeable[] = []
        for (let op = 0; op < 25; op++) {
          const roll = next()
          const integrationID = ids[Math.floor(next() * ids.length)]!
          const methodID = methods[Math.floor(next() * methods.length)]!
          if (roll < 0.3) {
            const scope = yield* Scope.make()
            const name = `name-${seed}-${op}`
            yield* integrations
              .transform((editor) =>
                editor.update(integrationID, (integration) => {
                  integration.name = name
                  integration.metadata = { seed, op }
                }),
              )
              .pipe(Scope.provide(scope))
            scopes.push(scope)
            scopedWrites++
          } else if (roll < 0.5) {
            const scope = yield* Scope.make()
            yield* integrations
              .transform((editor) =>
                editor.method.update({
                  integrationID,
                  method: { id: methodID, type: "oauth", label: `label-${seed}-${op}` },
                  authorize,
                }),
              )
              .pipe(Scope.provide(scope))
            scopes.push(scope)
            scopedWrites++
          } else if (roll < 0.6) {
            const scope = yield* Scope.make()
            yield* integrations
              .transform((editor) => editor.method.update({ integrationID, method: { type: "key", label: "API key" } }))
              .pipe(Scope.provide(scope))
            scopes.push(scope)
            scopedWrites++
          } else if (roll < 0.7 && scopes.length > 0) {
            const [scope] = scopes.splice(Math.floor(next() * scopes.length), 1)
            if (scope) yield* Scope.close(scope, Exit.void)
          } else {
            // Incremental read first, then a forced full replay of the same transforms; both must agree.
            const incremental = yield* integrations.list()
            yield* integrations.reload()
            const replay = yield* integrations.list()
            expect(incremental).toEqual(replay)
            for (const id of ids) {
              const single = yield* integrations.get(id)
              yield* integrations.reload()
              expect(single).toEqual(yield* integrations.get(id))
            }
            reads++
          }
        }
        const finalRead = yield* integrations.list()
        yield* integrations.reload()
        expect(finalRead).toEqual(yield* integrations.list())
        for (const scope of scopes) yield* Scope.close(scope, Exit.void)
      }
      expect(reads).toBeGreaterThan(200)
      expect(scopedWrites).toBeGreaterThan(200)
    }),
  )
})
