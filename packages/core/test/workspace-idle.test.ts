import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { KVTable } from "@opencode/core/kv/sql"
import { Workspace } from "@opencode/core/workspace"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { and, asc, eq, gt, gte, lt } from "drizzle-orm"
import { Clock, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const N = 300
const IDLE_PREFIX = "workspace.idle:"

// Counting KV over the real Database (same SQL as src/kv.ts), so every workspace idle read/write is visible.
const counts = { get: 0, scan: 0, set: 0, remove: 0 }
const countingKV = Layer.effect(
  KV.Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return KV.Service.of({
      get: Effect.fn("KV.get")(function* (key) {
        counts.get++
        return (yield* db
          .select({ value: KVTable.value })
          .from(KVTable)
          .where(eq(KVTable.key, key))
          .get()
          .pipe(Effect.orDie))?.value
      }),
      set: Effect.fn("KV.set")(function* (key, value) {
        counts.set++
        yield* db
          .insert(KVTable)
          .values({ key, value })
          .onConflictDoUpdate({ target: KVTable.key, set: { value, time_updated: Date.now() } })
          .run()
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("KV.remove")(function* (key) {
        counts.remove++
        yield* db.delete(KVTable).where(eq(KVTable.key, key)).run().pipe(Effect.orDie)
      }),
      scan: Effect.fn("KV.scan")(function* (options) {
        counts.scan++
        const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 1000)
        const rows = yield* db
          .select({ key: KVTable.key, value: KVTable.value })
          .from(KVTable)
          .where(
            and(
              gte(KVTable.key, options.prefix),
              lt(KVTable.key, `${options.prefix.slice(0, -1)}${String.fromCharCode(options.prefix.charCodeAt(options.prefix.length - 1) + 1)}`),
              options.after === undefined ? undefined : gt(KVTable.key, options.after),
            ),
          )
          .orderBy(asc(KVTable.key))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        const entries = rows.slice(0, limit)
        if (rows.length <= limit) return { entries }
        return { entries, next: entries[entries.length - 1].key }
      }),
    })
  }),
)

const events: Array<{ readonly id: string; readonly at: number }> = []
const driver = WorkspaceDriver.make({
  create: ({ workspaceID }) => Effect.succeed({ binding: { workspaceID, generation: 0 } }),
  connect: () => Effect.die(new Error("probe never connects")),
  suspendForIdle: ({ workspaceID, binding, saveBinding }) =>
    Effect.gen(function* () {
      events.push({ id: workspaceID, at: yield* Clock.currentTimeMillis })
      return yield* saveBinding({ ...binding, generation: Number(binding.generation) + 1, suspended: true })
    }),
  destroy: () => Effect.void,
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, KV.node, Workspace.configured({ idleThreshold: "20 minutes", pollInterval: "1 minute" })]),
    [
      // countingKV reads Database from the surrounding graph at runtime; the type only accepts closed layers.
      KV.node.replace(countingKV as Layer.Layer<KV.Service>),
      WorkspaceDriver.node.replace(WorkspaceDriver.registryNode({ fake: driver })),
    ],
  ),
)

describe("workspace idle probe", () => {
  it.effect("N pending idle entries over one simulated hour", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace.Service
      const kv = yield* KV.Service
      const t0 = yield* Clock.currentTimeMillis
      const dueAt = new Map<string, number>()
      for (let i = 0; i < N; i++) {
        const id = Workspace.ID.create()
        yield* workspace.attach({ id, provider: "fake", binding: { workspaceID: id, generation: 0 } })
        const due = t0 + Duration.toMillis(Duration.minutes(5)) + i * 12_000
        yield* kv.set(`${IDLE_PREFIX}${id}`, due)
        dueAt.set(id, due)
      }
      counts.get = counts.scan = counts.set = counts.remove = 0
      events.length = 0

      yield* TestClock.adjust(Duration.hours(1))

      const latencies = events.map((event) => event.at - (dueAt.get(event.id) ?? event.at))
      const maxLatency = Math.max(...latencies)
      console.log(
        JSON.stringify({
          probe: "workspace-idle",
          n: N,
          wakeupsKvScan: counts.scan,
          kvGet: counts.get,
          kvSet: counts.set,
          kvRemove: counts.remove,
          configReads: 0,
          emitted: events.length,
          maxExpiryLatencyMs: maxLatency,
          meanExpiryLatencyMs: latencies.reduce((a, b) => a + b, 0) / Math.max(latencies.length, 1),
        }),
      )
      const expected = [...dueAt.values()].filter((at) => at <= t0 + Duration.toMillis(Duration.hours(1))).length
      expect(events.length).toBe(expected)
    }),
  )
})
