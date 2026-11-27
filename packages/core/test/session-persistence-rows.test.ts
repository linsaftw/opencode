import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode/core/database/database"
import { Agent } from "@opencode/core/agent"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { Money } from "@opencode/schema/money"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

const sessionID = Session.ID.make("ses_persistence")
const userID = SessionMessage.ID.make("msg_user")
const firstAssistantID = SessionMessage.ID.make("msg_assistant_1")
const secondAssistantID = SessionMessage.ID.make("msg_assistant_2")
const succeededIdleID = SessionMessage.ID.fromEvent(Event.ID.make("evt_execution_succeeded"))
const interruptedIdleID = SessionMessage.ID.fromEvent(Event.ID.make("evt_interrupted"))
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const build = Agent.defaultID

describe("session persistence rows", () => {
  it.effect("keeps a fixed session event sequence byte-identical", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      const bus = yield* Bus.Service
      const publish = <D extends Event.Definition>(definition: D, data: Event.Data<D>, id: string) =>
        bus.publish(definition, data, { id: Event.ID.make(id) })

      yield* TestClock.setTime(1000)
      yield* publish(
        SessionEvent.Created,
        {
          sessionID,
          projectID: Project.ID.global,
          location: { directory: AbsolutePath.make("/project") },
          slug: "persistence",
          title: "persistence",
          version: "test",
        },
        "evt_created",
      )

      yield* TestClock.setTime(2000)
      yield* publish(
        SessionEvent.InboxEnqueued,
        {
          sessionID,
          inboxID: userID,
          item: { type: "user", payload: { text: "hello" }, delivery: "steer" },
        },
        "evt_user_enqueued",
      )

      yield* TestClock.setTime(3000)
      yield* publish(
        SessionEvent.InboxDelivered,
        { sessionID, inboxID: userID },
        "evt_user_delivered",
      )

      yield* TestClock.setTime(4000)
      yield* publish(
        SessionEvent.Step.Started,
        {
          sessionID,
          assistantMessageID: firstAssistantID,
          agent: build,
          model,
          started: 4000,
        },
        "evt_step1_started",
      )

      yield* TestClock.setTime(5000)
      yield* publish(
        SessionEvent.Text.Started,
        { sessionID, assistantMessageID: firstAssistantID, ordinal: 0 },
        "evt_text_started",
      )
      yield* TestClock.setTime(5500)
      yield* publish(
        SessionEvent.Text.Delta,
        { sessionID, assistantMessageID: firstAssistantID, ordinal: 0, delta: "Hel" },
        "evt_text_delta",
      )
      yield* TestClock.setTime(6000)
      yield* publish(
        SessionEvent.Text.Ended,
        { sessionID, assistantMessageID: firstAssistantID, ordinal: 0, text: "Hello" },
        "evt_text_ended",
      )

      yield* TestClock.setTime(7000)
      yield* publish(
        SessionEvent.Reasoning.Started,
        { sessionID, assistantMessageID: firstAssistantID, ordinal: 0 },
        "evt_reasoning_started",
      )
      yield* TestClock.setTime(7500)
      yield* publish(
        SessionEvent.Reasoning.Delta,
        { sessionID, assistantMessageID: firstAssistantID, ordinal: 0, delta: "Thi" },
        "evt_reasoning_delta",
      )
      yield* TestClock.setTime(8000)
      yield* publish(
        SessionEvent.Reasoning.Ended,
        { sessionID, assistantMessageID: firstAssistantID, ordinal: 0, text: "Think" },
        "evt_reasoning_ended",
      )

      yield* TestClock.setTime(9000)
      yield* publish(
        SessionEvent.Tool.Input.Started,
        { sessionID, assistantMessageID: firstAssistantID, id: "tool_1", name: "read" },
        "evt_tool1_input_started",
      )
      yield* TestClock.setTime(9500)
      yield* publish(
        SessionEvent.Tool.Input.Delta,
        { sessionID, assistantMessageID: firstAssistantID, id: "tool_1", delta: '{"path"' },
        "evt_tool1_input_delta",
      )
      yield* TestClock.setTime(10000)
      yield* publish(
        SessionEvent.Tool.Input.Ended,
        { sessionID, assistantMessageID: firstAssistantID, id: "tool_1", text: '{"path":"a.ts"}' },
        "evt_tool1_input_ended",
      )
      yield* TestClock.setTime(11000)
      yield* publish(
        SessionEvent.Tool.Called,
        {
          sessionID,
          assistantMessageID: firstAssistantID,
          id: "tool_1",
          input: { path: "a.ts" },
          executed: true,
        },
        "evt_tool1_called",
      )
      yield* TestClock.setTime(12000)
      yield* publish(
        SessionEvent.Tool.Success,
        {
          sessionID,
          assistantMessageID: firstAssistantID,
          id: "tool_1",
          content: [{ type: "text", text: "read ok" }],
          executed: true,
        },
        "evt_tool1_success",
      )

      yield* TestClock.setTime(13000)
      yield* publish(
        SessionEvent.Tool.Input.Started,
        { sessionID, assistantMessageID: firstAssistantID, id: "tool_2", name: "bash" },
        "evt_tool2_input_started",
      )
      yield* TestClock.setTime(13500)
      yield* publish(
        SessionEvent.Tool.Input.Delta,
        { sessionID, assistantMessageID: firstAssistantID, id: "tool_2", delta: '{"command"' },
        "evt_tool2_input_delta",
      )
      yield* TestClock.setTime(14000)
      yield* publish(
        SessionEvent.Tool.Input.Ended,
        { sessionID, assistantMessageID: firstAssistantID, id: "tool_2", text: '{"command":"false"}' },
        "evt_tool2_input_ended",
      )
      yield* TestClock.setTime(15000)
      yield* publish(
        SessionEvent.Tool.Called,
        {
          sessionID,
          assistantMessageID: firstAssistantID,
          id: "tool_2",
          input: { command: "false" },
          executed: true,
        },
        "evt_tool2_called",
      )
      yield* TestClock.setTime(16000)
      yield* publish(
        SessionEvent.Tool.Failed,
        {
          sessionID,
          assistantMessageID: firstAssistantID,
          id: "tool_2",
          error: { type: "tool.error", message: "command failed" },
          executed: true,
        },
        "evt_tool2_failed",
      )

      yield* TestClock.setTime(17000)
      yield* publish(
        SessionEvent.Step.Ended,
        {
          sessionID,
          assistantMessageID: firstAssistantID,
          finish: "stop",
          cost: Money.USD.make(0.25),
          tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
        },
        "evt_step1_ended",
      )

      yield* TestClock.setTime(17500)
      yield* publish(
        SessionEvent.Execution.Succeeded,
        { sessionID },
        "evt_execution_succeeded",
      )

      yield* TestClock.setTime(18000)
      yield* publish(
        SessionEvent.Step.Started,
        {
          sessionID,
          assistantMessageID: secondAssistantID,
          agent: build,
          model,
          started: 18000,
        },
        "evt_step2_started",
      )

      yield* TestClock.setTime(19000)
      yield* publish(
        SessionEvent.Execution.Interrupted,
        { sessionID, reason: "user" },
        "evt_interrupted",
      )

      const rows = yield* db
        .select({
          id: SessionMessageTable.id,
          session_id: SessionMessageTable.session_id,
          type: SessionMessageTable.type,
          seq: SessionMessageTable.seq,
          time_created: SessionMessageTable.time_created,
          data: SessionMessageTable.data,
        })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()

      expect(rows).toHaveLength(5)
      expect(
        rows.map((row) => ({
          id: row.id,
          session_id: row.session_id,
          type: row.type,
          seq: row.seq,
          time_created: row.time_created,
        })),
      ).toEqual([
        { id: userID, session_id: sessionID, type: "user", seq: 2, time_created: 3000 },
        { id: firstAssistantID, session_id: sessionID, type: "assistant", seq: 3, time_created: 4000 },
        { id: succeededIdleID, session_id: sessionID, type: "idle", seq: 17, time_created: 17500 },
        { id: secondAssistantID, session_id: sessionID, type: "assistant", seq: 18, time_created: 18000 },
        { id: interruptedIdleID, session_id: sessionID, type: "idle", seq: 19, time_created: 19000 },
      ])
      expect(rows.map((row) => row.data)).toEqual([
        { text: "hello", time: { created: 3000 } },
        {
          agent: build,
          model,
          content: [
            { type: "text", text: "Hello" },
            { type: "reasoning", text: "Think", time: { created: 7000, completed: 8000 } },
            {
              type: "tool",
              id: "tool_1",
              name: "read",
              executed: true,
              time: { created: 9000, ran: 11000, completed: 12000 },
              state: {
                status: "completed",
                input: { path: "a.ts" },
                content: [{ type: "text", text: "read ok" }],
              },
            },
            {
              type: "tool",
              id: "tool_2",
              name: "bash",
              executed: true,
              time: { created: 13000, ran: 15000, completed: 16000 },
              state: {
                status: "error",
                error: { type: "tool.error", message: "command failed" },
                input: { command: "false" },
              },
            },
          ],
          cost: 0.25,
          finish: "stop",
          tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
          time: { created: 4000, completed: 17000 },
        },
        { outcome: "succeeded", time: { created: 17500 } },
        { agent: build, model, content: [], time: { created: 18000 } },
        { outcome: "interrupted", time: { created: 19000 } },
      ])

      // There is no session_part table in the current event-sourced schema.
      expect(yield* db.select().from(EventSequenceTable).orderBy(asc(EventSequenceTable.aggregate_id)).all()).toEqual([
        { aggregate_id: sessionID, seq: 19, owner_id: null },
      ])

      const events = yield* db
        .select({ seq: EventTable.seq, type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      expect(events).toHaveLength(20)
      expect(events.map((event) => event.seq)).toEqual([...Array(20).keys()])
      // Live-only stream fragments never become durable rows.
      expect(events.filter((event) => event.type.includes("delta"))).toEqual([])
    }),
  )
})
