import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionBlob } from "@opencode/core/session/blob"
import { SessionStored } from "@opencode/core/session/stored"
import { BlobTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layer().pipe(Layer.provide(Layer.succeed(Global.Service, Global.make()))))

const sessionID = Session.ID.make("ses_media_cache")
const messageID = SessionMessage.ID.make("msg_media_cache_1")
const bytes = Buffer.from("first attachment bytes")

const files = (message: unknown) => (message as { files?: ReadonlyArray<{ data?: string; uri?: string }> }).files

describe("session history decode cache with media", () => {
  it.effect("returns the same hydrated media on a cache hit and re-decodes when the row changes", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: AbsolutePath.make("/project"),
          title: "test",
          version: "test",
        })
        .run()
      const hash = SessionBlob.hashBytes(bytes)
      yield* db.insert(BlobTable).values({ hash, mime: "image/png", bytes: bytes.length, data: bytes }).run()
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: messageID,
          session_id: sessionID,
          type: "user",
          seq: 1,
          time_created: 0,
          data: {
            text: "look",
            files: [{ uri: SessionStored.ref(hash), mime: "image/png", source: { type: "inline" } }],
            time: { created: 0 },
          },
        } as typeof SessionMessageTable.$inferInsert)
        .run()

      const first = yield* SessionHistory.load(db, sessionID, "local")
      const second = yield* SessionHistory.load(db, sessionID, "local")
      expect(files(first[0])?.[0]?.data).toBe(bytes.toString("base64"))
      expect(files(second[0])).toEqual(files(first[0]))

      // A changed row has a new hash and must not read the cached decode.
      yield* db
        .update(SessionMessageTable)
        .set({
          data: {
            text: "changed",
            files: [{ uri: SessionStored.ref(hash), mime: "image/png", source: { type: "inline" } }],
            time: { created: 0 },
          },
        } as Partial<typeof SessionMessageTable.$inferInsert>)
        .where(eq(SessionMessageTable.id, messageID))
        .run()
      const third = yield* SessionHistory.load(db, sessionID, "local")
      expect(JSON.stringify(third[0])).toContain("changed")
      expect(files(third[0])?.[0]?.data).toBe(bytes.toString("base64"))
    }),
  )
})
