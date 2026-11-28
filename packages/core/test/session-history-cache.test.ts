import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instructions } from "@opencode/core/instructions/index"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionInbox } from "@opencode/core/session/inbox"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { asc, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_history_cache")

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const inbox = yield* SessionInbox.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* bus.publish(SessionEvent.Created, {
    sessionID,
    projectID: Project.ID.global,
    location: { directory: AbsolutePath.make("/project") },
    slug: "history-cache",
    version: "test",
  })
  const instructions = Instructions.make({
    key: Instructions.Key.make("test/history-cache"),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.sync(() => "stable instructions"),
    render: { initial: String, changed: (_previous, value) => value, removed: () => "removed" },
  })
  const prepare = InstructionState.prepare(database.db, bus, instructions, sessionID)
  const prompt = Effect.fnUntraced(function* (text: string) {
    const id = SessionMessage.ID.create()
    yield* inbox.admit({ id, sessionID, item: { type: "user", payload: { text }, delivery: "steer" } })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
    return id
  })
  const compact = bus.publish(SessionEvent.Compaction.Ended, {
    sessionID,
    reason: "manual",
    text: "local summary",
  })
  const rows = database.db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
  const load = () => SessionHistory.entriesForRunner(database.db, sessionID, instructions, "local")
  return { db: database.db, bus, prepare, prompt, compact, rows, load }
})

// Uncached reference: decode every row in the window with the real decoder, no cache involved.
const reference = Effect.fnUntraced(function* (rows: (typeof SessionMessageTable.$inferSelect)[]) {
  const compaction = rows.filter((row) => row.type === "compaction").at(-1)
  const window = rows.filter((row) => compaction === undefined || row.seq >= compaction.seq)
  return yield* Effect.forEach(window, SessionHistory.decodeMessageRow)
})

it.effect("cached history matches uncached decode across prompts, compaction, edits and deletes", () =>
  Effect.gen(function* () {
    const s = yield* setup
    yield* s.prepare
    yield* s.prompt("one")
    yield* s.prompt("two")
    const first = yield* s.load()
    expect(first.entries.map((entry) => entry.message)).toEqual(yield* reference(yield* s.rows))

    yield* s.prompt("three")
    const second = yield* s.load()
    expect(second.entries.map((entry) => entry.message)).toEqual(yield* reference(yield* s.rows))
    // Unchanged rows are reused by identity, which shows they were not decoded again.
    expect(second.entries[0]?.message).toBe(first.entries[0]?.message)
    expect(second.entries[1]?.message).toBe(first.entries[1]?.message)

    // In-place edit of an existing row (projector-style update) must invalidate only that row.
    yield* s.db.run(
      sql`update session_message set data = json_set(data, '$.time.created', 4242) where session_id = ${sessionID} and data like '%"two"%'`,
    )
    const edited = yield* s.load()
    expect(edited.entries.map((entry) => entry.message)).toEqual(yield* reference(yield* s.rows))
    expect(edited.entries[1]?.message).not.toBe(second.entries[1]?.message)
    expect(edited.entries[0]?.message).toBe(second.entries[0]?.message)

    yield* s.compact
    yield* s.prompt("four")
    const compacted = yield* s.load()
    expect(compacted.entries.map((entry) => entry.message)).toEqual(yield* reference(yield* s.rows))
    expect(compacted.entries[0]?.message.type).toBe("compaction")

    // Deleting a tail row (revert-like) must drop it from the cached read.
    yield* s.db.run(
      sql`delete from session_message where session_id = ${sessionID} and seq = (select max(seq) from session_message where session_id = ${sessionID})`,
    )
    const reverted = yield* s.load()
    expect(reverted.entries.map((entry) => entry.message)).toEqual(yield* reference(yield* s.rows))
    expect(reverted.entries.length).toBe(compacted.entries.length - 1)
  }),
)

// Scoped cost probe: warm (fully cached) history reads at two sizes show how per-step cost grows with N.
it.effect("warm history read cost per step at 50 and 500 messages", () =>
  Effect.gen(function* () {
    const s = yield* setup
    yield* s.prepare
    const measure = Effect.fnUntraced(function* () {
      yield* s.load()
      const started = performance.now()
      for (let i = 0; i < 20; i++) yield* s.load()
      return (performance.now() - started) / 20
    })
    for (let i = 0; i < 50; i++) yield* s.prompt(`m${i}`)
    const small = yield* measure()
    for (let i = 50; i < 500; i++) yield* s.prompt(`m${i}`)
    const large = yield* measure()
    console.log(`warm load ms/step: N=50 ${small.toFixed(2)} N=500 ${large.toFixed(2)} ratio ${(large / small).toFixed(1)}`)
    expect(large).toBeGreaterThan(0)
  }),
  { timeout: 60_000 },
)
