import { describe, expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { make } from "@opencode/core/plugin/provider/lmstudio"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))

// Local stand-in for a local model server: counts discovery probes and can be switched to failing.
const origin = Effect.acquireRelease(
  Effect.sync(() => {
    const state = { failing: true, probes: 0 }
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        state.probes++
        if (state.failing) return new Response("down", { status: 500 })
        return Response.json({ models: [] })
      },
    })
    return { server, state }
  }),
  ({ server }) => Effect.sync(() => server.stop(true)),
)

// Advance virtual time in steps, letting each step's real HTTP round trip finish before the next.
const advance = (total: number, step: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < total; elapsed += step) {
      yield* TestClock.adjust(`${step} seconds`)
      yield* TestClock.withLive(Effect.sleep("5 millis"))
    }
  })

describe("local provider discovery backoff", () => {
  it.effect("probes a refused origin on exponential backoff, and resets to the interval after success", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, state } = yield* origin
        const plugin = yield* Plugin.Service
        const host = yield* PluginHost.make(plugin)
        yield* make(`http://127.0.0.1:${server.port}`, "30 seconds").effect(host)
        yield* TestClock.withLive(Effect.sleep("50 millis"))
        expect(state.probes).toBe(1)

        // Old cadence: one probe every 30 s, i.e. 120 per hour. Backoff: 30, 60, 120, 240, 300 s steps.
        yield* advance(3600, 30)
        expect(state.probes).toBeLessThanOrEqual(14)
        expect(state.probes).toBeGreaterThan(5)

        state.failing = false
        yield* advance(300, 30)
        const reset = state.probes
        yield* advance(30, 30)
        expect(state.probes).toBe(reset + 1)
        yield* advance(30, 30)
        expect(state.probes).toBe(reset + 2)
      }),
    ),
  )
})
