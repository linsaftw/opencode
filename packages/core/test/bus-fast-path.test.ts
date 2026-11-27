import { describe, expect } from "bun:test"
import { Effect, Fiber, Schema, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node])))

const Delta = Bus.ephemeral({
  type: "test.delta",
  schema: {
    text: Schema.String,
  },
})

describe("Bus ephemeral fast path", () => {
  it.effect("delivers ephemeral events to listeners and subscribers in publish order", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const seen: string[] = []
      const unsubscribe = yield* bus.listen((event) =>
        Effect.sync(() => {
          if (event.type === "test.delta") seen.push((event.data as { readonly text: string }).text)
        }),
      )
      const fiber = yield* bus.subscribe(Delta).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      for (const text of ["a", "b", "c"]) yield* bus.publish(Delta, { text })
      const received = (yield* Fiber.join(fiber)).map((event) => event.data.text)
      yield* unsubscribe
      expect(received).toEqual(["a", "b", "c"])
      expect(seen).toEqual(["a", "b", "c"])
    }),
  )

  it.effect("publishes with no listeners or session routing still return the event", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const event = yield* bus.publish(Delta, { text: "solo" })
      expect(event.type).toBe("test.delta")
      expect(event.data.text).toBe("solo")
    }),
  )
})
