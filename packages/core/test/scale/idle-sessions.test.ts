import { afterAll, describe, expect } from "bun:test"
import { Clock, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { testEffect } from "../lib/effect"
import { globalProjectNode } from "../lib/project"
import { promptLocationNode } from "../fixture/prompt-location"

// Counts every Effect sleep started through the Clock service. A sleep is the only
// way an idle Effect fiber schedules a timer, so `pending` is the live timer count.
const probe = { started: 0, pending: 0 }

const countingClock = Layer.effect(
  Clock.Clock,
  Effect.gen(function* () {
    const inner = yield* Clock.Clock
    const sleep = (duration: Parameters<typeof inner.sleep>[0]) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          probe.started++
          probe.pending++
        }),
        () => inner.sleep(duration),
        () =>
          Effect.sync(() => {
            probe.pending--
          }),
      )
    return Object.assign(Object.create(inner), { sleep })
  }),
)

const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Bus.node,
    SessionProjector.node,
    SessionStore.node,
    SessionInbox.node,
    Session.node,
  ]),
  [
    Bus.node.replace(Bus.configured({ persist: true })),
    Project.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ],
)
const layer = Layer.provideMerge(appLayer, countingClock)

const scaleIt = testEffect(layer)

// Heap ceiling per idle session in bytes. Set from the first measured run plus 50%.
// Measured worst case 50613 B/session (sim, N=50, includes warm-up) + 50% = 75920 B, rounded up.
const HEAP_PER_SESSION_CEILING = 76_000

type Row = {
  mode: "sim" | "real"
  n: number
  timersPerSession: number
  startedPerSession: number
  heapPerSession: number
  cpuMsPerSession: number | undefined
  cpuMsTotal: number | undefined
  wallMs: number
}
const rows: Row[] = []

const heapUsed = () => {
  Bun.gc(true)
  return process.memoryUsage().heapUsed
}

const scenario = (mode: Row["mode"], n: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
    const pendingBase = probe.pending
    const heapBase = heapUsed()

    yield* Effect.forEach(
      Array.from({ length: n }),
      () => sessions.create({ location }),
      { discard: true },
    )

    const pendingAfterCreate = probe.pending - pendingBase
    const heapPerSession = (heapUsed() - heapBase) / n

    const startedBefore = probe.started
    let cpuMsTotal: number | undefined
    let wallMs: number
    if (mode === "sim") {
      yield* TestClock.adjust("1 second")
      wallMs = 1000
    } else {
      const cpu0 = process.cpuUsage()
      const t0 = performance.now()
      const measureStarted = probe.started
      yield* Effect.sleep("1 second")
      wallMs = performance.now() - t0
      const cpu = process.cpuUsage(cpu0)
      cpuMsTotal = (cpu.user + cpu.system) / 1000
      // The measuring sleep itself is one started sleep; subtract it.
      expect(probe.started - measureStarted - 1).toBeGreaterThanOrEqual(0)
    }
    const startedDuringWindow = probe.started - startedBefore - (mode === "real" ? 1 : 0)

    rows.push({
      mode,
      n,
      timersPerSession: pendingAfterCreate / n,
      startedPerSession: startedDuringWindow / n,
      heapPerSession,
      cpuMsPerSession: cpuMsTotal === undefined ? undefined : cpuMsTotal / n,
      cpuMsTotal,
      wallMs,
    })

    // Per-session timers must be zero: total pending may only grow by a constant.
    expect(pendingAfterCreate).toBeLessThanOrEqual(1)
    expect(startedDuringWindow).toBeLessThanOrEqual(1)
    expect(heapPerSession).toBeLessThanOrEqual(HEAP_PER_SESSION_CEILING)
  })

describe("idle session scale", () => {
  for (const n of [50, 200, 400]) {
    scaleIt.effect(`sim: ${n} idle sessions, 1 simulated second`, () => scenario("sim", n), 120_000)
    scaleIt.live(`real: ${n} idle sessions, 1 real second`, () => scenario("real", n), 120_000)
  }
})

afterAll(() => {
  if (rows.length === 0) return
  const fmt = (x: number | undefined, d = 2) => (x === undefined ? "n/a" : x.toFixed(d))
  const lines = [
    "mode  N    timers/sess  sleeps/sess(1s)  heap/sess(B)  cpu_ms/sess  cpu_ms_total  wall_ms",
    ...rows.map((r) =>
      [
        r.mode.padEnd(4),
        String(r.n).padStart(4),
        fmt(r.timersPerSession, 4).padStart(11),
        fmt(r.startedPerSession, 4).padStart(15),
        fmt(r.heapPerSession, 0).padStart(12),
        fmt(r.cpuMsPerSession, 4).padStart(11),
        fmt(r.cpuMsTotal, 2).padStart(13),
        fmt(r.wallMs, 1).padStart(8),
      ].join("  "),
    ),
  ]
  console.log(lines.join("\n"))
})
