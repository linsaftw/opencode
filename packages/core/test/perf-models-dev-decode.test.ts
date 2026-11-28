import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { KV } from "@opencode/core/kv"
import { bodyDigest, ModelsDev } from "@opencode/core/models-dev"
import snapshotText from "../src/models-dev/snapshot.txt" with { type: "text" }

// Micro-bench for one component: ModelsDev.get() on a KV-cached catalog (the steady-state boot), a fresh layer per run
// so each run pays populate -> normalize (or the normalized memo). Median of 20 in one process.
// PROBE_DUMP=<file> writes the list for recommended false and true, for a before/after deepEqual.
const runs = 20

const encode = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (item === undefined ? "__undefined__" : item), 1)

const values = new Map<string, KV.Value>([
  ["models-dev:v4:catalog", { updatedAt: Date.now(), digest: bodyDigest(snapshotText), body: snapshotText }],
])
const kv = Layer.mock(KV.Service, {
  get: (key) => Effect.sync(() => values.get(key)),
  set: (key, value) => Effect.sync(() => void values.set(key, value)),
  remove: (key) => Effect.sync(() => void values.delete(key)),
})

const getSnapshots = (recommended: boolean) =>
  ModelsDev.Service.use((service) => service.get(recommended)).pipe(
    Effect.provide(
      Layer.fresh(
        AppNodeBuilder.build(LayerNode.group([ModelsDev.node, Bus.node]), [
          ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
          KV.node.replace(kv),
        ]),
      ),
    ),
    Effect.scoped,
    Effect.runPromise,
  )

describe("perf models-dev decode", () => {
  test("ModelsDev.get on a KV-cached catalog: median of 20", async () => {
    const first = await getSnapshots(false)
    const models = first.reduce((sum, item) => sum + item.models.length, 0)
    const wall: number[] = []
    const cpu: number[] = []
    for (let index = 0; index < runs; index++) {
      const usage = process.cpuUsage()
      const started = performance.now()
      await getSnapshots(false)
      wall.push(performance.now() - started)
      const used = process.cpuUsage(usage)
      cpu.push((used.user + used.system) / 1000)
    }
    const median = (items: number[]) => [...items].sort((a, b) => a - b)[Math.floor(items.length / 2)]
    console.log(
      JSON.stringify({
        bytes: snapshotText.length,
        providers: first.length,
        models,
        wallMsMedian: Number(median(wall).toFixed(1)),
        cpuMsMedian: Number(median(cpu).toFixed(1)),
        wallMs: wall.map((item) => Number(item.toFixed(1))),
      }),
    )
    const dump = process.env.PROBE_DUMP
    if (dump) {
      const recommended = await getSnapshots(true)
      await Bun.write(dump, encode({ plain: first, recommended }))
    }
    expect(first.length).toBeGreaterThan(0)
  }, 600_000)
})
