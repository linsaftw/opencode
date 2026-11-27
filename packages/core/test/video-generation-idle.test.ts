import path from "node:path"
import { expect } from "bun:test"
import { Clock, Effect, Layer, Stream, Tracer } from "effect"
import { TestClock } from "effect/testing"
import type { VideoStatus } from "@opencode/ai/effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Generate } from "@opencode/core/generate"
import { BlobStore } from "@opencode/core/blob-store"
import { KV } from "@opencode/core/kv"
import { VideoGeneration } from "@opencode/core/video-generation"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { eventually } from "./lib/eventually"

const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("video") })

const mp4 = Uint8Array.from([0, 0, 0, 0x14, ...new TextEncoder().encode("ftypmp42"), 0, 0, 0, 0, 1, 2, 3, 4])

const app = (dir: string, state: { finished: boolean; reads: number[] }) =>
  AppNodeBuilder.build(
    LayerNode.group([VideoGeneration.node, BlobStore.node, Database.node, KV.node, LocationServiceMap.node]),
    [
      Global.node.replace(Global.layerWith({ data: path.join(dir, "data"), config: path.join(dir, "config") })),
      Database.node.replace(Database.configured({ path: "opencode.db" })),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      Generate.node.replace(
        makeLocationNode({
          service: Generate.Service,
          layer: Layer.succeed(
            Generate.Service,
            Generate.Service.of({
              text: () => Effect.die("unused"),
              image: () => Effect.die("unused"),
              decisions: () => Effect.die("unused"),
              video: {
                start: () => Effect.succeed({ id: "remote_1" }),
                status: (): Effect.Effect<VideoStatus> =>
                  Effect.gen(function* () {
                    state.reads.push(yield* Clock.currentTimeMillis)
                    return state.finished ? { status: "completed" } : { status: "running" }
                  }),
                result: () => Effect.succeed([{ mime: "video/mp4", stream: Stream.make(mp4) }]),
                cancel: () => Effect.void,
              },
            }),
          ),
          deps: [],
        }),
      ),
    ],
  )

// Lets the timers a TestClock adjustment fired run their real (async) work before the next step.
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)))

// Counts the `KV.scan` spans: every full read of the video records opens one.
function countScans() {
  const counter = { count: 0 }
  const tracer = Tracer.make({
    span(options) {
      if (options.name === "KV.scan") counter.count++
      return Tracer.nativeTracer.span(options)
    },
  })
  return { counter, tracer }
}

const records = KV.Service.pipe(Effect.flatMap((kv) => kv.scan({ prefix: "video:" })))

it.effect("idle video polling reads the records about once a minute, and a new job is checked within 5 seconds", () => {
  const { counter, tracer } = countScans()
  return Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-generation-")).path
    const state = { finished: false, reads: [] as number[] }
    yield* Effect.gen(function* () {
      const generations = yield* VideoGeneration.Service
      yield* settle
      const before = counter.count
      for (let step = 0; step < 12; step++) {
        yield* TestClock.adjust("5 seconds")
        yield* settle
      }
      const idleScans = counter.count - before
      expect(idleScans).toBeLessThanOrEqual(2)

      // The last tick's follow-up work must finish before the job starts, so its next sleep is armed at the same clock.
      yield* Effect.promise(() => Bun.sleep(50))
      const started = yield* Clock.currentTimeMillis
      const job = yield* generations.start({ model, prompt: "a cat" })
      state.finished = true
      const found = yield* eventually(
        TestClock.adjust("500 millis").pipe(Effect.andThen(settle), Effect.andThen(generations.get(job.id))),
        (value) => value.status !== "running",
      )
      expect(found).toMatchObject({ status: "completed" })
      // The first provider read after the start is the pickup: it must come within INTERVAL of the start.
      expect(state.reads[0]! - started).toBeLessThanOrEqual(5000)

      yield* TestClock.adjust("25 hours")
      yield* eventually(
        TestClock.adjust("5 seconds").pipe(Effect.andThen(records)),
        (page) => page.entries.length === 0,
      )
    }).pipe(Effect.provide(app(dir, state)))
  }).pipe(Effect.provideService(Tracer.Tracer, tracer))
}, 60_000)
