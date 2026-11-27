import { Event } from "@opencode/schema/event"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { EventFeed } from "../event-feed"

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const feed = yield* EventFeed.Service
    const heartbeats = yield* EventFeed.heartbeatHub()
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        const output = Stream.unwrap(
          feed
            .subscribe(ctx.query.types)
            .pipe(
              Effect.map((subscription) =>
                Stream.make(
                  EventFeed.frame({
                    id: Event.ID.create(),
                    type: "server.connected",
                    data: { stream: subscription.id },
                  }),
                ).pipe(Stream.concat(subscription.events)),
              ),
            ),
        )
        return HttpServerResponse.stream(
          output.pipe(
            Stream.merge(EventFeed.heartbeatStream(heartbeats), { haltStrategy: "left" }),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
