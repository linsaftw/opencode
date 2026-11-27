import { describe, expect } from "bun:test"
import { Duration, Effect, Metric } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, Bus.node])))

describe("integration scrubber idle wakeups", () => {
  it.effect("wakes zero times per simulated hour with no tracked attempts", () =>
    Effect.gen(function* () {
      const before = (yield* Metric.value(Integration.scrubWakeups)).count
      yield* TestClock.adjust(Duration.hours(1))
      const after = (yield* Metric.value(Integration.scrubWakeups)).count
      expect(after - before).toBe(0)
    }),
  )
})
