// Scoped perf probe: share of write time spent in the session search FTS triggers during a scripted
// streaming turn. Runs the same 200 turns in four arms on bun:sqlite in memory:
//   control        base tables only
//   full           the real SessionSearchIndex.ensure() triggers
//   noCompletion   full, minus the session_message update trigger (the per-completion reindex)
//   cheapGuard     full, but the per-delta session_part update WHEN has no EXISTS (column tests only, never true)
// The gap full - noCompletion is the per-completion cost; full - cheapGuard is the per-delta EXISTS guard cost.
// PROBE_OUT=<file> writes the JSON report.
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { SQLiteDialect } from "drizzle-orm/sqlite-core/dialect"
import type { SQL } from "drizzle-orm"
import { SessionSearchIndex } from "@opencode/core/session/search-index"
import { writeFileSync } from "node:fs"

const Turns = 200
const Deltas = 200

const base = `
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE session_part (message_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, type TEXT NOT NULL,
    call_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (message_id, ordinal));
`

const dialect = new SQLiteDialect()
const toQuery = (query: string | SQL) => {
  if (typeof query === "string") return { sql: query, params: [] as Array<unknown> }
  return dialect.sqlToQuery(query)
}

// Adapter from the Database.Interface["db"] surface the index uses to bun:sqlite.
// The index keeps its build state in the KV table through the drizzle query builder. A fresh probe database has no
// state, so reads resolve to nothing and writes are dropped; the DDL and triggers under test are unaffected.
const kvStub = (): any => {
  const chain: any = new Proxy(() => chain, {
    get: (_, key) => (key === "get" || key === "run" ? () => Effect.succeed(undefined) : () => chain),
  })
  return chain
}

const open = () => {
  const raw = new Database(":memory:")
  raw.exec(base)
  const db = {
    select: kvStub,
    insert: kvStub,
    run: (query: string | SQL) =>
      Effect.sync(() => {
        const q = toQuery(query)
        raw.query(q.sql).run(...(q.params as Array<string>))
      }),
    all: (query: string | SQL) =>
      Effect.sync(() => {
        const q = toQuery(query)
        return raw.query(q.sql).all(...(q.params as Array<string>))
      }),
    get: (query: string | SQL) =>
      Effect.sync(() => {
        const q = toQuery(query)
        return raw.query(q.sql).get(...(q.params as Array<string>))
      }),
    transaction: <A, E>(effect: () => Effect.Effect<A, E>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => raw.exec("BEGIN IMMEDIATE")),
        () => effect(),
        () => Effect.sync(() => raw.exec("COMMIT")),
      ),
  }
  return { raw, db }
}

type Db = Parameters<typeof SessionSearchIndex.ensure>[0]

// One streamed assistant turn: user prompt, assistant message, 200 text deltas, one tool part, then completion.
const runTurns = (raw: Database, turn0: number) => {
  const started = performance.now()
  const changesBefore = (raw.query("SELECT total_changes() AS n").get() as { n: number }).n
  const insMsg = raw.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, 0, 0, ?)")
  const insPart = raw.query("INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, NULL, 0, 0, ?)")
  const updPart = raw.query("UPDATE session_part SET data = ?, time_updated = ? WHERE message_id = ? AND ordinal = ?")
  const updMsg = raw.query("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?")
  const insSession = raw.query("INSERT INTO session_v2 (id, title) VALUES (?, ?)")
  const writeTurn = raw.transaction((turn: number) => {
    const session = `ses_${Math.floor(turn / 10)}`
    if (turn % 10 === 0) insSession.run(session, `Session ${turn} about parsing and indexing`)
    const user = `msg_u_${turn}`
    const asst = `msg_a_${turn}`
    insMsg.run(user, session, "user", turn * 2, JSON.stringify({ text: `question ${turn} about the search index` }))
    insMsg.run(asst, session, "assistant", turn * 2 + 1, JSON.stringify({ time: { created: 1 } }))
    insPart.run(asst, session, 0, "text", JSON.stringify({ text: "" }))
    for (let k = 1; k <= Deltas; k++) updPart.run(JSON.stringify({ text: `delta ${k} `.repeat(k).slice(0, k * 6) }), k, asst, 0)
    insPart.run(asst, session, 1, "tool", JSON.stringify({ tool: "read" }))
    updMsg.run(JSON.stringify({ time: { created: 1, completed: 2 } }), 2, asst)
  })
  writeTurn(turn0)
  const elapsed = performance.now() - started
  const changes = (raw.query("SELECT total_changes() AS n").get() as { n: number }).n - changesBefore
  return { elapsed, changes }
}

type Arm = "control" | "full" | "noCompletion" | "cheapGuard" | "noPartUpdate"

// Builds one arm on a fresh database. The arm edits the real triggers after ensure(), so the rest of the DDL is shared.
const setup = (arm: Arm) =>
  Effect.gen(function* () {
    const { raw, db } = open()
    if (arm === "control") return raw
    const result = yield* SessionSearchIndex.ensure(db as unknown as Db)
    if (result.status !== "ready") throw new Error(`ensure returned ${result.status}`)
    if (arm === "noCompletion") raw.exec("DROP TRIGGER session_search_message_update")
    if (arm === "noPartUpdate") raw.exec("DROP TRIGGER session_search_part_update")
    if (arm === "cheapGuard") {
      raw.exec("DROP TRIGGER session_search_part_update")
      raw.exec(
        `CREATE TRIGGER session_search_part_update AFTER UPDATE OF type, data, ordinal ON session_part
           WHEN NEW.type = 'text' AND NEW.ordinal < 0 BEGIN SELECT 1; END`,
      )
    }
    return raw
  })

const measure = (arm: Arm) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const raw = yield* setup(arm)
      const triggers = (raw.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get() as { n: number }).n
      let elapsed = 0
      let changes = 0
      for (let turn = 0; turn < Turns; turn++) {
        const run = runTurns(raw, turn)
        elapsed += run.elapsed
        changes += run.changes
      }
      const hits = arm === "full"
        ? (raw.query("SELECT count(*) AS n FROM session_search WHERE session_search MATCH 'indexing'").get() as { n: number }).n
        : 0
      raw.close()
      return { triggers, elapsed, changes, hits }
    }),
  )

test("session search trigger share of a 200-turn streaming write load", async () => {
  // Warm up the JIT and statement cache once so the first timed run is not an outlier.
  // Each arm runs three times, interleaved, and keeps its fastest run: the machine is shared and noisy.
  const best = async (arm: Arm) => {
    const runs = [await measure(arm), await measure(arm), await measure(arm)]
    return runs.reduce((a, b) => (b.elapsed < a.elapsed ? b : a))
  }
  await measure("control")
  const control = await best("control")
  const indexed = await best("full")
  const noCompletion = await best("noCompletion")
  const cheapGuard = await best("cheapGuard")
  const noPartUpdate = await best("noPartUpdate")
  const share = (indexed.elapsed - control.elapsed) / indexed.elapsed
  const report = {
    turns: Turns,
    deltasPerTurn: Deltas,
    layout: "compact",
    triggers: indexed.triggers,
    controlMs: Math.round(control.elapsed),
    indexedMs: Math.round(indexed.elapsed),
    noCompletionMs: Math.round(noCompletion.elapsed),
    cheapGuardMs: Math.round(cheapGuard.elapsed),
    noPartUpdateMs: Math.round(noPartUpdate.elapsed),
    ftsShare: Number(share.toFixed(4)),
    completionShare: Number(((indexed.elapsed - noCompletion.elapsed) / indexed.elapsed).toFixed(4)),
    deltaGuardShare: Number(((indexed.elapsed - cheapGuard.elapsed) / indexed.elapsed).toFixed(4)),
    rowsChangedControl: control.changes,
    rowsChangedIndexed: indexed.changes,
    ftsRowsPerTurn: Number(((indexed.changes - control.changes) / Turns).toFixed(2)),
    searchHits: indexed.hits,
  }
  const out = process.env.PROBE_OUT
  if (out) writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  expect(indexed.triggers).toBeGreaterThan(0)
  expect(indexed.hits).toBeGreaterThan(0)
}, 120000)

// Equivalence: the same corpus (50 sessions, streamed turns, post-completion part edits, message and session deletes)
// must give identical hits whether the part trigger guards with the instr() prefilter or with the bare EXISTS test.
const corpus = (raw: Database) => {
  const insSession = raw.query("INSERT INTO session_v2 (id, title) VALUES (?, ?)")
  const insMsg = raw.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, 0, 0, ?)")
  const insPart = raw.query("INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, NULL, 0, 0, ?)")
  const updPart = raw.query("UPDATE session_part SET data = ?, time_updated = ? WHERE message_id = ? AND ordinal = ?")
  const updMsg = raw.query("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?")
  for (let i = 0; i < 50; i++) {
    const session = `ses_${i}`
    insSession.run(session, i % 4 === 3 ? "" : `Session ${i} parsing alpha${i % 6}`)
    for (let k = 0; k < 3; k++) {
      const turn = i * 3 + k
      const user = `msg_u_${turn}`
      const asst = `msg_a_${turn}`
      insMsg.run(user, session, "user", turn * 2, JSON.stringify({ text: `question ${k} of ${session} about indexing alpha${i % 6}` }))
      insMsg.run(asst, session, "assistant", turn * 2 + 1, JSON.stringify({ time: { created: 1 } }))
      insPart.run(asst, session, 0, "text", JSON.stringify({ text: "" }))
      for (let d = 1; d <= 20; d++) updPart.run(JSON.stringify({ text: `delta ${d} streaming` }), d, asst, 0)
      insPart.run(asst, session, 1, "tool", JSON.stringify({ tool: "read" }))
      updMsg.run(JSON.stringify({ time: { created: 1, completed: 2 } }), 2, asst)
      if (i % 5 === 0 && k === 1) updPart.run(JSON.stringify({ text: "edited words gamma" }), 3, asst, 0)
    }
  }
  for (let i = 0; i < 50; i += 7) raw.exec(`DELETE FROM session_message WHERE id = 'msg_u_${i * 3}'`)
  for (let i = 0; i < 50; i += 11) {
    raw.exec(`DELETE FROM session_part WHERE session_id = 'ses_${i}'`)
    raw.exec(`DELETE FROM session_message WHERE session_id = 'ses_${i}'`)
    raw.exec(`DELETE FROM session_v2 WHERE id = 'ses_${i}'`)
  }
}

// Reads the hits as source ids, so a row-level difference in the index shows up even when counts match.
const hitsOf = (raw: Database) =>
  ["indexing", "delta", "gamma", "edited", "parsing", "question", "alpha1", "streaming"].map((term) =>
    (raw.query(
      "SELECT d.source_id AS id FROM session_search AS s JOIN session_search_document AS d ON d.id = s.rowid WHERE session_search MATCH ? ORDER BY d.source_id",
    ).all(term) as Array<{ id: string }>).map((row) => row.id),
  )

const withPrefilter = (raw: Database, prefilter: boolean) => {
  const row = raw.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'session_search_part_update'").get() as { sql: string }
  raw.exec("DROP TRIGGER session_search_part_update")
  const sql = prefilter ? row.sql : row.sql.replace("instr(m.data, '\"completed\"') > 0 AND ", "")
  if (!prefilter && sql === row.sql) throw new Error("prefilter not found in trigger SQL")
  raw.exec(sql)
}

test("instr prefilter keeps search hits identical on a 50-session corpus", () => {
  const hits = (prefilter: boolean) => {
    const { raw, db } = open()
    Effect.runSync(SessionSearchIndex.ensure(db as unknown as Db))
    withPrefilter(raw, prefilter)
    corpus(raw)
    const result = hitsOf(raw)
    raw.close()
    return result
  }
  const bare = hits(false)
  const guarded = hits(true)
  expect(guarded).toEqual(bare)
  expect(guarded.some((ids) => ids.length > 0)).toBe(true)
  expect(guarded[2]?.length).toBeGreaterThan(0)
})
