import { describe, expect } from "bun:test"
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
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layer().pipe(Layer.provide(Layer.succeed(Global.Service, Global.make()))))

const sessionID = Session.ID.make("ses_part_lookup")
const created = DateTime.makeUnsafe(0)
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Info)
const MESSAGES = 5_000

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
        data: SessionHistory.encodePart({ type: "text", text: `part ${row.id} ${ordinal}` }),
      })),
    )
    for (const batch of DatabaseBatch.insertBatches(SessionPartTable, parts)) {
      yield* db.insert(SessionPartTable).values(batch).run()
    }
    return { db, rows }
  })

describe("session history part lookup", () => {
  it.effect("reads every part of a long window in one query and keeps ordinal order", () =>
    Effect.gen(function* () {
      const { db, rows } = yield* seed(MESSAGES)
      const all = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)

      let selects = 0
      const counting = Object.create(db) as typeof db
      counting.select = ((...args: Parameters<typeof db.select>) => {
        selects++
        return db.select(...args)
      }) as typeof db.select

      const merged = yield* SessionHistory.withParts(counting, all)
      // The old batched lookup issued MESSAGES / MaxBoundParameters statements; the session-scoped read issues one.
      expect(selects).toBe(1)
      expect(merged).toHaveLength(MESSAGES)
      for (const message of merged) {
        const content = (message.data as { content?: unknown }).content
        expect(Array.isArray(content) && content.length === 2).toBe(true)
      }
      const first = merged[0]!.data as { content: Array<{ text: string }> }
      expect(first.content.map((part) => part.text)).toEqual([`part ${rows[0]!.id} 0`, `part ${rows[0]!.id} 1`])
    }),
  )
})
