import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode/core/database/database"
import { Agent } from "@opencode/core/agent"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionStore } from "@opencode/core/session/store"
import { Session } from "@opencode/core/session"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Money } from "@opencode/schema/money"
import { testEffect } from "./lib/effect"

// Replays a scripted multi-tool, multi-text, reasoning step through the real projector.
// Guards: persisted rows must match the golden snapshot byte-for-byte, and the
// per-event UPDATE count is observed at the database through a temp trigger.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

const sessionID = Session.ID.make("ses_projector_writes")
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const build = Agent.defaultID
const message = SessionMessage.ID.make("msg_scripted_step")
const golden = path.join(import.meta.dir, "session-projector-assistant-writes.golden.json")

describe("SessionProjector assistant writes", () => {
  it.effect("persists identical assistant rows and bounds UPDATEs per durable event", () =>
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
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      yield* db.run(sql`create temp table write_log (n integer)`)
      yield* db.run(
        sql`create temp trigger count_update after update on session_message begin insert into write_log values (1); end`,
      )
      const bus = yield* Bus.Service
      const writes = () => db.all<{ n: number }>(sql`select count(*) as n from write_log`).pipe(Effect.orDie)
      const usage = { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } }
      const script = [
        () => bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: message, agent: build, model, started: 1 }),
        () => bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: message, ordinal: 0 }),
        () => bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: message, ordinal: 0, text: "Reading files" }),
        () => bus.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID: message, id: "call_read", name: "read" }),
        () => bus.publish(SessionEvent.Tool.Input.Ended, { sessionID, assistantMessageID: message, id: "call_read", text: '{"path":"a.ts"}' }),
        () => bus.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID: message, id: "call_read", input: { path: "a.ts" }, executed: true }),
        () => bus.publish(SessionEvent.Tool.Success, { sessionID, assistantMessageID: message, id: "call_read", executed: true, content: [{ type: "text", text: "A" }] }),
        () => bus.publish(SessionEvent.Reasoning.Started, { sessionID, assistantMessageID: message, ordinal: 0 }),
        () => bus.publish(SessionEvent.Reasoning.Ended, { sessionID, assistantMessageID: message, ordinal: 0, text: "Need grep" }),
        () => bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: message, ordinal: 1 }),
        () => bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: message, ordinal: 1, text: "Searching" }),
        () => bus.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID: message, id: "call_grep", name: "grep" }),
        () => bus.publish(SessionEvent.Tool.Input.Ended, { sessionID, assistantMessageID: message, id: "call_grep", text: '{"q":"x"}' }),
        () => bus.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID: message, id: "call_grep", input: { q: "x" }, executed: true }),
        () => bus.publish(SessionEvent.Tool.Failed, { sessionID, assistantMessageID: message, id: "call_grep", executed: true, error: { type: "provider.transport", message: "Disconnected" } }),
        () => bus.publish(SessionEvent.Tool.Input.Ended, { sessionID, assistantMessageID: message, id: "call_unknown", text: "{}" }),
        () => bus.publish(SessionEvent.Step.Streamed, { sessionID, assistantMessageID: message }),
        () => bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: message, ordinal: 2 }),
        () => bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: message, ordinal: 2, text: "Done" }),
        () => bus.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: message, finish: "stop", cost: Money.USD.make(1.25), tokens: usage }),
        () => bus.publish(SessionEvent.Execution.Succeeded, { sessionID }),
      ]
      // Expected UPDATEs per event with the optimized projector. The unmatched
      // tool.input.ended for an unknown call (index 15) must not rewrite the row.
      const expectedWrites = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0]
      const observed: number[] = []
      for (const step of script) {
        const before = (yield* writes())[0]?.n ?? 0
        yield* step()
        observed.push(((yield* writes())[0]?.n ?? 0) - before)
      }

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      // time_updated is wall-clock touch noise and idle IDs derive from random event IDs; all other bytes are compared.
      const actual = JSON.stringify(
        rows.map((row) => ({ ...row, id: row.type === "idle" ? "idle" : row.id, time_updated: 0 })),
      )
      if (process.env.UPDATE_GOLDEN === "1") yield* Effect.promise(() => Bun.write(golden, actual))
      expect(actual).toBe(yield* Effect.promise(() => Bun.file(golden).text()))
      expect(observed).toEqual(expectedWrites)
    }),
  )
})
