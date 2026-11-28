import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Npm } from "@opencode/util/npm"
import { Plugin } from "@opencode/core/plugin"
import { PluginInternal } from "@opencode/core/plugin/internal"
import { Provider } from "@opencode/core/provider"
import { Mcp } from "@opencode/core/mcp/index"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { emptyMcpLayer } from "./fixture/mcp"
import { offlineModels } from "./fixture/models"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"

// Boots a Location's real built-in plugin list through Plugin.activate (the same batch the supervisor uses),
// then performs the reads a Location start makes. No network: models are offline and no provider is called.
// Set OPENCODE_STATE_REBUILD_LOG to a file path to record each State rebuild (temporary instrumentation).
describe("Location start rebuild probe", () => {
  const it = testEffect(
    AppNodeBuilder.build(LayerNode.group([Plugin.node, PluginInternal.requirements]), [
      Location.node.replace(tempLocationLayer),
      Npm.node.replace(
        Layer.succeed(
          Npm.Service,
          Npm.Service.of({
            add: (name) => Effect.succeed({ directory: "", name }),
            resolve: (name) => Effect.succeed({ directory: "", name }),
            check: () => Effect.succeed(false),
            update: (name) => Effect.succeed({ directory: "", name }),
            follows: () => Effect.succeed(false),
            reject: () => Effect.succeed(false),
            which: () => Effect.undefined,
          }),
        ),
      ),
      Mcp.node.replace(emptyMcpLayer),
      offlineModels,
    ]).pipe(Layer.provideMerge(Config.testLayer())),
  )

  it.effect("activates built-in plugins and reads the provider snapshot", () =>
    Effect.gen(function* () {
      const registry = yield* Plugin.Service
      const internal = yield* PluginInternal.list()
      yield* registry.activate([...internal.pre, ...internal.post])
      const providers = yield* Provider.Service
      const snapshot = yield* providers.snapshot()
      expect(snapshot).toBeDefined()
    }),
  )
})
