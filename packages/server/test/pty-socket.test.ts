import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Queue } from "effect"
import { Socket } from "effect/socket"
import { it } from "../../core/test/lib/effect"
import {
  OUTBOX_CAPACITY,
  offerOutbound,
  type Outbound,
  OutboxOverflowError,
  runPtySocket,
} from "../src/handlers/pty-socket"

const connection = Effect.gen(function* () {
  const inbound = yield* Queue.unbounded<string | Uint8Array, Socket.SocketError>()
  const outbox = yield* Queue.unbounded<Outbound>()
  const state = {
    opened: false,
    detached: false,
    received: [] as Array<string | Uint8Array>,
    written: [] as Outbound[],
  }
  const socket = Socket.make({
    reader: Effect.succeed({
      pull: Queue.take(inbound).pipe(Effect.map((message) => [message] as const)),
      upgrade: Socket.SocketUpgradeError.unsupported,
    }),
    writer: Effect.succeed({
      write: (chunk) => Effect.sync(() => void state.written.push(chunk)),
      writeAll: (chunks) => Effect.sync(() => void state.written.push(...chunks)),
    }),
  })
  const run = runPtySocket({
    socket,
    outbox,
    onOpen: Effect.sync(() => {
      state.opened = true
    }),
    onMessage: (message) =>
      Effect.sync(() => {
        expect(state.opened).toBeTrue()
        state.received.push(message)
      }),
    detach: () => {
      state.detached = true
    },
  })
  return { inbound, outbox, state, run }
})

const fail = (reason: Socket.SocketError["reason"]) => new Socket.SocketError({ reason })

it.live("delivers input in order and detaches when the client closes", () =>
  Effect.gen(function* () {
    const pty = yield* connection
    yield* Queue.offerAll(pty.inbound, ["a", "b"])
    yield* Queue.fail(pty.inbound, fail(new Socket.SocketCloseError({ code: 1000 })))

    expect(yield* Effect.exit(pty.run)).toEqual(Exit.void)
    expect(pty.state.received).toEqual(["a", "b"])
    expect(pty.state.detached).toBeTrue()
  }),
)

it.live("writes queued output through the close frame and detaches", () =>
  Effect.gen(function* () {
    const pty = yield* connection
    const close = new Socket.CloseEvent(1000)
    yield* Queue.offerAll(pty.outbox, ["output", close, "after close"])

    expect(yield* Effect.exit(pty.run)).toEqual(Exit.void)
    expect(pty.state.written).toEqual(["output", close])
    expect(pty.state.detached).toBeTrue()
  }),
)

it.live("detaches when the socket fails while the outbox drain is blocked", () =>
  Effect.gen(function* () {
    const pty = yield* connection
    yield* Queue.fail(pty.inbound, fail(new Socket.SocketReadError({ cause: new Error("reset") })))

    expect(Exit.hasDies(yield* Effect.exit(pty.run))).toBeTrue()
    expect(pty.state.detached).toBeTrue()
  }),
)

it.live("detaches when interrupted", () =>
  Effect.gen(function* () {
    const pty = yield* connection
    const fiber = yield* Effect.forkChild(pty.run, { startImmediately: true })
    yield* Fiber.interrupt(fiber)

    expect(pty.state.opened).toBeTrue()
    expect(pty.state.detached).toBeTrue()
  }),
)

it.live("closes a slow client whose bounded outbox overflows, without blocking the producer", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const inbound = yield* Queue.unbounded<string | Uint8Array, Socket.SocketError>()
    const outbox = yield* Queue.bounded<Outbound, OutboxOverflowError>(OUTBOX_CAPACITY)
    const written: Outbound[] = []
    let detached = false
    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Queue.take(inbound).pipe(Effect.map((message) => [message] as const)),
        upgrade: Socket.SocketUpgradeError.unsupported,
      }),
      writer: Effect.succeed({
        write: (chunk) =>
          Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => void written.push(chunk)))),
        writeAll: (chunks) =>
          Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => void written.push(...chunks)))),
      }),
    })

    // The client never drains, so every offer past capacity must overflow instead of growing the queue.
    for (let i = 0; i < OUTBOX_CAPACITY + 10_000; i++) offerOutbound(outbox, "frame")
    const run = yield* runPtySocket({
      socket,
      outbox,
      onMessage: () => Effect.void,
      detach: () => {
        detached = true
      },
    }).pipe(Effect.forkChild)
    yield* Deferred.succeed(gate, undefined)

    expect(yield* Fiber.await(run).pipe(Effect.map(Exit.isSuccess))).toBeTrue()
    expect(written).toHaveLength(1)
    expect(written[0]).toBeInstanceOf(Socket.CloseEvent)
    expect((written[0] as Socket.CloseEvent).code).toBe(1013)
    expect(detached).toBeTrue()
  }),
)

it.live("delivers every frame to a healthy client filling the outbox to capacity", () =>
  Effect.gen(function* () {
    const inbound = yield* Queue.unbounded<string | Uint8Array, Socket.SocketError>()
    const outbox = yield* Queue.bounded<Outbound, OutboxOverflowError>(OUTBOX_CAPACITY)
    const frames: Outbound[] = Array.from({ length: OUTBOX_CAPACITY - 1 }, (_, i) => `frame-${i}`)
    const close = new Socket.CloseEvent(1000)
    const written: Outbound[] = []
    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Queue.take(inbound).pipe(Effect.map((message) => [message] as const)),
        upgrade: Socket.SocketUpgradeError.unsupported,
      }),
      writer: Effect.succeed({
        write: (chunk) => Effect.sync(() => void written.push(chunk)),
        writeAll: (chunks) => Effect.sync(() => void written.push(...chunks)),
      }),
    })
    for (const frame of frames) offerOutbound(outbox, frame)
    offerOutbound(outbox, close)

    expect(yield* Effect.exit(runPtySocket({ socket, outbox, onMessage: () => Effect.void, detach: () => {} }))).toEqual(
      Exit.void,
    )
    expect(written).toEqual([...frames, close])
  }),
)
