import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("perf-provider-calls") })),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Provider.node, Credential.node, Integration.node, Bus.node]), [
    Location.node.replace(locationLayer),
  ]),
)

// Regression guard for the per-call cost of Provider reads: each read queries the
// integration list exactly once, so a caller that stacks reads multiplies that query.
describe("Provider reads per call", () => {
  it.effect("each snapshot-backed read lists integrations once", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const providers = yield* Provider.Service

      let listReads = 0
      const list = integrations.list
      Object.assign(integrations, {
        list: () => {
          listReads++
          return list()
        },
      })

      const count = (read: Effect.Effect<unknown>) =>
        Effect.gen(function* () {
          listReads = 0
          yield* read
          return listReads
        })

      expect(yield* count(providers.available())).toBe(1)
      expect(yield* count(providers.snapshot())).toBe(1)
      expect(yield* count(providers.all())).toBe(0)
    }),
  )
})
