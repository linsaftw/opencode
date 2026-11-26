export * as EventFeed from "./event-feed"

import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { isOpenCodeEvent, type OpenCodeEvent } from "@opencode/protocol/groups/event"
import { Cause, Context, Effect, Layer, Queue, Schema, Scope, Stream } from "effect"

export const SubscriberCapacity = 4_096

export class SubscriberOverflowError extends Schema.TaggedError<SubscriberOverflowError>()(
  "EventFeed.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export class EncodingError extends Schema.TaggedError<EncodingError>()("EventFeed.EncodingError", {
  eventID: Event.ID,
  eventType: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Error = SubscriberOverflowError | EncodingError

/** One rendered event shared by every subscriber; the UTF-8 bytes are encoded at most once, on first byte demand. */
interface Frame {
  readonly text: string
  bytes?: Uint8Array
}

const encoder = new TextEncoder()
const encodeFrame = (frame: Frame) => (frame.bytes ??= encoder.encode(frame.text))

export interface Interface {
  readonly subscribe: (types?: ReadonlyArray<string>) => Effect.Effect<Stream.Stream<string, Error>, never, Scope.Scope>
  /** Same frames as {@link subscribe}, already UTF-8 encoded; the bytes are shared between subscribers and must not be mutated. */
  readonly subscribeBytes: (
    types?: ReadonlyArray<string>,
  ) => Effect.Effect<Stream.Stream<Uint8Array, Error>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/EventFeed") {}

export function frame(event: OpenCodeEvent) {
  return `data: ${JSON.stringify(event)}\n\n`
}

export const make = Effect.fn("EventFeed.make")(function* (
  observe: (subscriber: Bus.Subscriber) => Effect.Effect<Bus.Unsubscribe>,
  options?: { readonly capacity?: number; readonly encode?: (event: OpenCodeEvent) => string },
) {
  const capacity = options?.capacity ?? SubscriberCapacity
  const render = options?.encode ?? frame
  const subscribers = new Map<Queue.Queue<Frame, Error>, ReadonlySet<string> | undefined>()

  const fail = (error: Error) =>
    Effect.sync(() => {
      const current = Array.from(subscribers.keys())
      subscribers.clear()
      for (const subscriber of current) Queue.failCauseUnsafe(subscriber, Cause.fail(error))
    })

  const publish = Effect.fnUntraced(function* (event: Event.Payload) {
    if (!isOpenCodeEvent(event)) return
    let encoded: Frame | undefined
    for (const [subscriber, types] of subscribers) {
      if (types && !types.has(event.type)) continue
      encoded ??= yield* Effect.try({
        try: (): Frame => ({ text: render(event) }),
        catch: (cause) => new EncodingError({ eventID: event.id, eventType: event.type, cause }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("Failed to encode public event", {
            eventID: error.eventID,
            eventType: error.eventType,
            cause: error.cause,
          }).pipe(Effect.andThen(fail(error)), Effect.as(undefined)),
        ),
      )
      if (encoded === undefined) return
      if (Queue.offerUnsafe(subscriber, encoded)) continue
      subscribers.delete(subscriber)
      Queue.failCauseUnsafe(subscriber, Cause.fail(new SubscriberOverflowError({ capacity })))
    }
  })

  const unsubscribe = yield* observe(publish)
  yield* Effect.addFinalizer(() => unsubscribe)

  const frames = (types?: ReadonlyArray<string>) =>
    Effect.acquireRelease(
      Queue.dropping<Frame, Error>(capacity).pipe(
        Effect.tap((queue) => Effect.sync(() => subscribers.set(queue, types?.length ? new Set(types) : undefined))),
      ),
      (queue) => Effect.sync(() => subscribers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid),
    ).pipe(Effect.map(Stream.fromQueue))

  return Service.of({
    subscribe: (types) => frames(types).pipe(Effect.map(Stream.map((frame) => frame.text))),
    subscribeBytes: (types) => frames(types).pipe(Effect.map(Stream.map(encodeFrame))),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    return yield* make(bus.listen)
  }),
)
