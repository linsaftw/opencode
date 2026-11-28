import { LocationLifecycle } from "@opencode/core/location-lifecycle"
import { Cause, Effect, Queue, Schema } from "effect"
import { Socket } from "effect/socket"

export type Outbound = string | Uint8Array | Socket.CloseEvent

// Same policy as the SSE feed: a slow client whose outbox fills is closed, and nothing else is affected.
export const OUTBOX_CAPACITY = 4_096

export class OutboxOverflowError extends Schema.TaggedError<OutboxOverflowError>()(
  "PtySocket.OutboxOverflow",
  { capacity: Schema.Int },
) {}

// Outbound frames flow through one queue drained by a single writer so replay, live output, and the close
// frame keep their order. Either side closing ends the connection normally, and every exit detaches.
export function runPtySocket<R>(input: {
  readonly socket: Socket.Socket
  readonly outbox: Queue.Dequeue<Outbound, OutboxOverflowError>
  readonly onOpen?: Effect.Effect<void, never, R>
  readonly onMessage: (message: string | Uint8Array) => Effect.Effect<void, never, R>
  readonly detach: () => void
}) {
  const drain = Effect.gen(function* () {
    const writer = yield* input.socket.writer
    while (true) {
      const item = yield* Queue.take(input.outbox).pipe(
        Effect.catchTag("PtySocket.OutboxOverflow", () =>
          Effect.succeed(new Socket.CloseEvent(1013, "client too slow")),
        ),
      )
      yield* writer.write(item)
      if (item instanceof Socket.CloseEvent) return
    }
  })
  const read = Effect.gen(function* () {
    const reader = yield* input.socket.reader
    if (input.onOpen) yield* input.onOpen
    while (true) yield* Effect.forEach(yield* reader.pull, input.onMessage, { discard: true })
  })
  return Effect.raceFirst(drain, read).pipe(
    Effect.ensuring(Effect.sync(input.detach)),
    Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
    Effect.orDie,
  )
}

// A socket borrows its Location for as long as it stays open. Its client reconnects right away when the socket
// closes, so it keeps the idle sweep from evicting the Location (eviction would only boot a fresh one). Any other
// shutdown (reload, VCS init, debug eviction) closes the socket with 1012, which releases the borrow so the
// Location's scope can close, and the client reconnects to the replacement.
export const holdLocation = Effect.fnUntraced(function* (outbox: Queue.Queue<Outbound, OutboxOverflowError>) {
  const lifecycle = yield* LocationLifecycle.Service
  yield* lifecycle.retain
  yield* lifecycle.awaitShutdown.pipe(
    Effect.andThen(Effect.sync(() => offerOutbound(outbox, new Socket.CloseEvent(1012, "location shut down")))),
    Effect.forkChild,
  )
})

// Never blocks the producer. A full outbox fails the queue and shuts it down: the writer closes the socket with
// 1013 and the buffered frames are released. Offers after that are no-ops.
export function offerOutbound(outbox: Queue.Queue<Outbound, OutboxOverflowError>, item: Outbound) {
  if (Queue.offerUnsafe(outbox, item)) return
  Queue.failCauseUnsafe(outbox, Cause.fail(new OutboxOverflowError({ capacity: OUTBOX_CAPACITY })))
  Queue.shutdownUnsafe(outbox)
}
