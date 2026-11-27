import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { EventFeed } from "../src/event-feed"
import { it } from "../../core/test/lib/effect"

const CLIENTS = 200

function heapMB() {
  Bun.gc(true)
  return process.memoryUsage().heapUsed / 1024 / 1024
}

describe("SSE shared heartbeat", () => {
  it.effect("one ticker serves N clients with identical frames and 15s cadence", () =>
    Effect.gen(function* () {
      const hub = yield* EventFeed.heartbeatHub()
      const frames = yield* Ref.make<string[]>([])
      const before = heapMB()
      const clients = yield* Effect.forEach(
        Array.from({ length: CLIENTS }),
        (_, index) =>
          EventFeed.heartbeatStream(hub).pipe(
            Stream.runForEach((frame) => Ref.update(frames, (all) => [...all, `${index}:${frame}`])),
            Effect.forkScoped,
          ),
        { discard: false },
      )
      yield* Effect.yieldNow
      const after = heapMB()
      yield* TestClock.adjust("1 minute")
      yield* Effect.yieldNow
      const received = yield* Ref.get(frames)
      console.log(
        `heartbeat clients=${CLIENTS} window=1m frames=${received.length} heapDeltaMB=${(after - before).toFixed(2)} perClientKB=${(((after - before) * 1024) / CLIENTS).toFixed(2)}`,
      )
      expect(received.length).toBe(CLIENTS * 5)
      expect(new Set(received.map((entry) => entry.slice(entry.indexOf(":") + 1)))).toEqual(
        new Set([EventFeed.HEARTBEAT_FRAME]),
      )
      yield* Fiber.interruptAll(clients)
    }).pipe(Effect.scoped),
  )

})

test("heartbeat frame is the SSE comment the wire has always carried", () => {
  expect(EventFeed.HEARTBEAT_FRAME).toBe(": heartbeat\n\n")
  expect(EventFeed.HEARTBEAT_INTERVAL).toBe("15 seconds")
})
