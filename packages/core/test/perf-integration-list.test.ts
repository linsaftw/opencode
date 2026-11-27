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

const count = 50
const calls = 1000

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("perf-integration-list") })),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Provider.node, Credential.node, Integration.node, Bus.node]), [
    Location.node.replace(locationLayer),
  ]),
)

const integrationID = (index: number) => Integration.ID.make(`perf-int-${index}`)
const providerID = (index: number) => Provider.ID.make(`perf-provider-${index}`)

// Micro-bench for one component: Provider.available() cost and credential reads per call.
describe("Provider.available reads", () => {
  it.effect("counts credential reads and time per available() call", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const providers = yield* Provider.Service
      const credentials = yield* Credential.Service

      yield* integrations.transform((editor) => {
        for (let index = 0; index < count; index++) {
          editor.update(integrationID(index), (integration) => {
            integration.name = `Perf ${index}`
          })
        }
      })
      yield* providers.transform((editor) => {
        for (let index = 0; index < count; index++) {
          editor.update(providerID(index), (provider) => {
            provider.integrationID = integrationID(index)
          })
        }
      })
      for (let index = 0; index < count; index++) {
        yield* credentials.create({
          integrationID: integrationID(index),
          label: `key ${index}`,
          value: Credential.Key.make({ type: "key", key: `secret-${index}` }),
        })
      }

      let allReads = 0
      let listReads = 0
      const all = credentials.all
      const list = credentials.list
      Object.assign(credentials, {
        all: () => {
          allReads++
          return all()
        },
        list: (integrationID: Integration.ID) => {
          listReads++
          return list(integrationID)
        },
      })

      const started = performance.now()
      let available = 0
      for (let call = 0; call < calls; call++) {
        available = (yield* providers.available()).length
      }
      const elapsed = performance.now() - started

      console.log(
        JSON.stringify({
          bench: "Provider.available",
          integrations: count,
          calls,
          available,
          msPerCall: Number((elapsed / calls).toFixed(4)),
          credentialAllReads: allReads,
          credentialListReads: listReads,
          allReadsPerCall: allReads / calls,
        }),
      )
      expect(available).toBe(count)
    }),
  )
})
