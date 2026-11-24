import { describe } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Agent } from "@opencode/core/agent"
import { Session } from "@opencode/schema/session"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Database } from "@opencode/core/database/database"
import { Layer } from "effect"
import { Global } from "@opencode/util/global"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionMessageTable, SessionPartTable, SessionTable } from "@opencode/core/session/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { DatabaseBatch } from "@opencode/core/database/batch"
import { SessionBlob } from "@opencode/core/session/blob"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layer().pipe(Layer.provide(Layer.succeed(Global.Service, Global.make()))))

const sessionID = Session.ID.make("ses_long_perf")
const created = DateTime.makeUnsafe(0)
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

const assistantRow = (index: number) => {
  const id = SessionMessage.ID.make(`msg_${String(index).padStart(8, "0")}`)
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({
      id,
      type: "assistant",
      agent: Agent.defaultID,
      model,
      content: [],
      time: { created },
    }),
  )
  return { id, session_id: sessionID, type, seq: index, time_created: 0, data }
}

const seed = (count: number) =>
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
    const rows = Array.from({ length: count }, (_, index) => assistantRow(index + 1))
    for (const batch of DatabaseBatch.insertBatches(SessionMessageTable, rows)) {
      yield* db.insert(SessionMessageTable).values(batch).run()
    }
    const parts = rows.flatMap((row) =>
      [0, 1].map((ordinal) => ({
        message_id: row.id,
        session_id: sessionID,
        ordinal,
        type: "text" as const,
        call_id: null,
        time_created: 0,
        time_updated: 0,
        data: SessionHistory.encodePart({ type: "text", text: "a short synthetic tool result for measurement" }),
      })),
    )
    for (const batch of DatabaseBatch.insertBatches(SessionPartTable, parts)) {
      yield* db.insert(SessionPartTable).values(batch).run()
    }
    return db
  })

describe("long session perf measurement", () => {
  for (const size of [1_000, 5_000, 20_000]) {
    it.live(`history load of ${size} messages`, () =>
      Effect.gen(function* () {
        const db = yield* seed(size)
        const started = performance.now()
        const messages = yield* SessionHistory.load(db, sessionID, "latest")
        const elapsed = performance.now() - started

        let t = performance.now()
        const rows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
        const selectMs = performance.now() - t
        t = performance.now()
        const parts = yield* SessionHistory.withParts(db, rows)
        const partsMs = performance.now() - t
        t = performance.now()
        const hydrated = yield* SessionBlob.hydrate(db, parts)
        const hydrateMs = performance.now() - t
        t = performance.now()
        yield* Effect.forEach(hydrated, SessionHistory.decodeMessageRow, { concurrency: 1 })
        const decodeMs = performance.now() - t
        t = performance.now()
        hydrated.forEach(SessionHistory.decodeMessageRowSync)
        const syncDecodeMs = performance.now() - t
        console.log(
          `LOAD size=${size} messages=${messages.length} totalMs=${elapsed.toFixed(1)} select=${selectMs.toFixed(1)} parts=${partsMs.toFixed(1)} hydrate=${hydrateMs.toFixed(1)} decode=${decodeMs.toFixed(1)} syncDecode=${syncDecodeMs.toFixed(1)}`,
        )
      }),
    )
  }
})
