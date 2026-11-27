import { describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { Form } from "@opencode/core/form"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { LocationActivity } from "@opencode/core/location-activity"
import { LocationServiceMap, type LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Workspace } from "@opencode/core/workspace"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStore } from "@opencode/core/session/store"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { testEffect } from "./lib/effect"

// Counts every Config.entries() read: the sweep evaluates idleTimeout, which reads each cached location's config.
let configReads = 0

const countedConfig = Layer.effect(
  Config.Service,
  Effect.gen(function* () {
    const inner = yield* Config.Test
    return Config.Service.of({
      ...inner,
      entries: () =>
        Effect.suspend(() => {
          configReads++
          return inner.entries()
        }),
    })
  }),
).pipe(Layer.provide(Config.testLayer([])))

const locations = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    return yield* LocationServiceMap.make(
      (ref: Location.Ref) =>
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Layer.mergeAll(
          countedConfig,
          Layer.succeed(
            Location.Service,
            Location.Service.of({
              directory: ref.directory,
              workspaceID: ref.workspaceID,
              project: { id: Project.ID.global, directory: ref.directory, canonical: ref.directory },
            }),
          ),
          Layer.effect(
            SessionRunner.Service,
            Effect.succeed(SessionRunner.Service.of({ drain: () => Effect.succeed(SessionRunner.DrainResult.Complete()) })),
          ),
        ).pipe(
          Layer.provideMerge(Form.layer),
          Layer.provide(Layer.succeed(Bus.Service, bus)),
          Layer.fresh,
        ) as unknown as Layer.Layer<LocationServices, never>,
      { idleTimeToLive: Duration.infinity },
    )
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      SessionStore.node,
      LocationServiceMap.node,
      SessionExecution.node,
      LocationActivity.node,
    ]),
    [
      LocationServiceMap.node.replace(
        makeGlobalNode({
          service: LocationServiceMap.Service,
          layer: locations,
          deps: [Bus.node],
        }),
      ),
    ],
  ),
)

const COUNT = 300
const MINUTES = 62

describe("LocationActivity sweep probe", () => {
  it.effect(`sweeps ${COUNT} tracked locations for one simulated hour`, () =>
    Effect.gen(function* () {
      const map = yield* LocationServiceMap.Service
      const heapBefore = (Bun.gc(true), process.memoryUsage().heapUsed)
      for (let index = 0; index < COUNT; index++) {
        const ref = Location.Ref.make({
          directory: AbsolutePath.make("/project"),
          workspaceID: Workspace.ID.make(`wrk_sweep_${index}`),
        })
        yield* Location.Service.pipe(Effect.provide(map.get(ref)), Effect.scoped)
      }
      const heapLoaded = (Bun.gc(true), process.memoryUsage().heapUsed)
      configReads = 0

      const timeline: Array<{ minute: number; cached: number; reads: number }> = []
      for (let minute = 1; minute <= MINUTES; minute++) {
        yield* TestClock.adjust("1 minute")
        timeline.push({ minute, cached: (yield* map.keys).length, reads: configReads })
      }
      const evictedAt = timeline.filter((row, index) => index > 0 && row.cached < timeline[index - 1]!.cached)
      const hourReads = timeline[59]!.reads
      console.log(
        JSON.stringify({
          locations: COUNT,
          configReadsOneHour: hourReads,
          configReadsPerMinute: hourReads / 60,
          evictions: evictedAt,
          heapBytesPerEntry: Math.round((heapLoaded - heapBefore) / COUNT),
        }),
      )
      expect(hourReads).toBeGreaterThan(0)
      expect(timeline.at(-1)!.cached).toBe(0)
      expect(evictedAt.map((row) => row.minute)).toEqual([61])
    }),
  )
})
