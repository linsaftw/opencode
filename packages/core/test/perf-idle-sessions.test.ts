import { expect } from "bun:test"
import { Effect } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const WINDOW_MS = 1000

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

// Timer and immediate handles alive in this process; sessions must not add per-session ones.
const timerCount = () =>
  process.getActiveResourcesInfo().filter((name) => name === "Timeout" || name === "Immediate").length

const createSessions = (from: number, to: number) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* Effect.forEach(
      Array.from({ length: to - from }, (_, i) => from + i),
      (i) =>
        bus.publish(SessionEvent.Created, {
          sessionID: SessionSchema.ID.make(`ses_idle_${i}`),
          projectID: Project.ID.global,
          location: { directory: AbsolutePath.make("/project") },
          slug: `idle-${i}`,
          version: "test",
        }),
      { discard: true },
    )
  })

// Waits WINDOW_MS of wall time (TestClock does not advance real CPU or timers) and reports
// process CPU (user+system) and the change in timer handles across the window.
const idleWindow = (sessions: number) =>
  Effect.gen(function* () {
    const timersBefore = timerCount()
    const cpuBefore = process.cpuUsage()
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, WINDOW_MS)))
    const cpu = process.cpuUsage(cpuBefore)
    const cpuMs = (cpu.user + cpu.system) / 1000
    return { sessions, cpuMs, perSession: cpuMs / sessions, timers: timerCount() - timersBefore }
  })

it.effect("idle CPU per session and timer handles do not grow with session count", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()

    yield* createSessions(0, 10)
    const at10 = yield* idleWindow(10)

    // Keep the first 10 open and add 190 more, so the N=200 window holds 200 idle sessions.
    yield* createSessions(10, 200)
    const at200 = yield* idleWindow(200)

    console.log(
      `idle cpu ms per session: N=10 ${at10.perSession.toFixed(4)}, N=200 ${at200.perSession.toFixed(4)} ` +
        `(window cpu ms: N=10 ${at10.cpuMs.toFixed(1)}, N=200 ${at200.cpuMs.toFixed(1)})`,
    )
    console.log(`active timer/immediate delta: N=10 ${at10.timers}, N=200 ${at200.timers}`)

    expect(at200.timers).toBeLessThanOrEqual(at10.timers + 2)
  }),
)
