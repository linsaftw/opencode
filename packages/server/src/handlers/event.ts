import { Event } from "@opencode/schema/event"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { EventFeed } from "../event-feed"

const encoder = new TextEncoder()
const heartbeatBytes = encoder.encode(": heartbeat\n\n")
const heartbeat = Stream.tick("15 seconds").pipe(Stream.as(heartbeatBytes))

const headers = {
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
} as const

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const feed = yield* EventFeed.Service
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        const connected = {
          id: Event.ID.create(),
          type: "server.connected",
          data: {},
        } as const
        const output = Stream.unwrap(
          feed
            .subscribeBytes(ctx.query.types)
            .pipe(
              Effect.map((live) =>
                Stream.make(encoder.encode(EventFeed.frame(connected))).pipe(Stream.concat(live)),
              ),
            ),
        )
        return HttpServerResponse.stream(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" })), {
          contentType: "text/event-stream",
          headers,
        })
      }),
    )
  }),
)
