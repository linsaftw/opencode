import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { KVTable } from "@opencode/core/kv/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionSearchIndex } from "@opencode/core/session/search-index"
import { SessionTable } from "@opencode/core/session/sql"
import { testEffect } from "./lib/effect"

// Scoped measurement of a SessionSearchIndex rebuild (version bump) on a populated database. One component, one
// build, reported as composition: max blocking chunk, chunk count, reset cost, rows per second.


const directory = AbsolutePath.make("/project")
const pad = (value: number) => String(value).padStart(7, "0")
const Paragraph = "The quick brown fox jumps over the lazy dog while the build cache warms up slowly. "
// About 5 text parts of ~250 bytes plus a small envelope, so each assistant message is roughly 1.3 KB of stored text.
const PartText = Paragraph.repeat(3).slice(0, 250)
const PartsPerMessage = 5
const Batch = 500

const populate = (db: Database.Interface["db"], messages: number) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    const sessions = Math.max(1, Math.ceil(messages / 100))
    yield* db
      .insert(SessionTable)
      .values(
        Array.from({ length: sessions }, (_, index) => ({
          id: Session.ID.make(`ses_${pad(index)}`),
          project_id: Project.ID.global,
          slug: `ses_${pad(index)}`,
          directory,
          title: `Rebuild benchmark session ${index} with walrus`,
          version: "test",
        })),
      )
      .run()
      .pipe(Effect.orDie)
    for (let start = 0; start < messages; start += Batch) {
      const end = Math.min(messages, start + Batch)
      const messageRows: string[] = []
      const partRows: string[] = []
      for (let index = start; index < end; index++) {
        const message = `msg_${pad(index)}`
        const session = `ses_${pad(index % sessions)}`
        const now = Date.now()
        messageRows.push(
          `('${message}', '${session}', 'assistant', ${index}, ${now}, ${now}, '{"time":{"created":${now},"completed":${now}}}')`,
        )
        for (let ordinal = 0; ordinal < PartsPerMessage; ordinal++) {
          partRows.push(
            `('${message}', '${session}', ${ordinal}, 'text', NULL, ${now}, ${now}, '{"type":"text","text":"${index}-${ordinal} ${PartText}"}')`,
          )
        }
      }
      yield* db
        .run(
          sql.raw(
            `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ${messageRows.join(", ")}`,
          ),
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql.raw(
            `INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) VALUES ${partRows.join(", ")}`,
          ),
        )
        .pipe(Effect.orDie)
    }
  })

const build = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const start = performance.now()
    yield* SessionSearchIndex.ensure(db)
    const ensureMs = performance.now() - start
    const chunks: number[] = []
    let done = false
    while (!done) {
      const began = performance.now()
      const result = yield* SessionSearchIndex.buildChunk(db)
      chunks.push(performance.now() - began)
      done = result.done
    }
    const total = performance.now() - start
    const state = yield* SessionSearchIndex.state(db)
    return { ensureMs, total, chunks, processed: SessionSearchIndex.current(state) ? state.processed : 0 }
  })

const report = (messages: number, result: { ensureMs: number; total: number; chunks: number[]; processed: number }) => {
  const sorted = result.chunks.toSorted((left, right) => left - right)
  return {
    messages,
    sessions: Math.max(1, Math.ceil(messages / 100)),
    processed: result.processed,
    chunks: result.chunks.length,
    ensureMs: Math.round(result.ensureMs),
    totalMs: Math.round(result.total),
    maxChunkMs: Math.round(sorted.at(-1) ?? 0),
    p50ChunkMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    rowsPerSec: Math.round(result.processed / (result.total / 1000)),
  }
}

describe("session search rebuild cost on a populated database", () => {
  for (const messages of [2000, 10000, 40000]) {
    const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
    it.effect(
      `bump rebuild at ${messages} messages`,
      () =>
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          yield* populate(db, messages)
          const first = yield* build(db)
          // Simulate an older version on the existing database: ensure must drop the populated index and rebuild.
          yield* db
            .update(KVTable)
            .set({ value: sql`json_set(${KVTable.value}, '$.version', 0)` })
            .where(eq(KVTable.key, "session.search"))
            .run()
            .pipe(Effect.orDie)
          const bump = yield* build(db)
          const counts = yield* db.all<{ messages: number; parts: number }>(
            sql`SELECT (SELECT count(*) FROM session_message) AS messages, (SELECT count(*) FROM session_part) AS parts`,
          )
          console.log(
            JSON.stringify({
              first: report(messages, first),
              bump: report(messages, bump),
              rows: counts,
            }),
          )
          expect(bump.processed).toBeGreaterThan(messages)
        }),
      { timeout: 600_000 },
    )
  }
})
