import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import schema from "@opencode/core/database/schema.gen"
import migration from "@opencode/core/database/migration/20261127183842_session_list_index"
import { Global } from "@opencode/util/global"

type Tx = Parameters<typeof migration.up>[0]

const rawTx = (db: Database) =>
  ({
    run: (query: string) => Effect.sync(() => db.run(query)),
  }) as unknown as Tx

const run = <A>(effect: Effect.Effect<A, unknown, Global.Service>) =>
  Effect.runSync(effect.pipe(Effect.provideService(Global.Service, Global.make({ data: process.cwd() }))))

const SEED = 5000
const PROJECTS = 10
const DIRECTORIES = 25

const queries = {
  projectList: [
    "SELECT * FROM session_v2 WHERE project_id = ? ORDER BY time_updated DESC, id DESC LIMIT 50",
    [`prj_${3}`],
  ],
  globalList: ["SELECT * FROM session_v2 ORDER BY time_updated DESC, id DESC LIMIT 50", []],
  directoryList: [
    "SELECT * FROM session_v2 WHERE directory = ? ORDER BY time_updated DESC, id DESC LIMIT 50",
    [`/dir/${7}`],
  ],
} as const

const insert = (db: Database) =>
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, '1', ?, ?)`,
  )

// Deterministic seed with many equal time_updated values so the id tie-break is exercised.
const seed = (db: Database, from: number, count: number) => {
  const stmt = insert(db)
  db.transaction(() => {
    for (let i = from; i < from + count; i++) {
      const project = `prj_${i % PROJECTS}`
      const directory = `/dir/${(i * 31) % DIRECTORIES}`
      const updated = (i * 7919) % 1000
      stmt.run(`ses_${String(i).padStart(6, "0")}`, project, `slug-${i}`, directory, updated, updated)
    }
  })()
  stmt.finalize()
}

const createTables = (db: Database) => {
  run(schema.up(rawTx(db)))
}

// Pre-migration state for session_v2 indexes: the single project index, no list indexes.
const reversePreState = (db: Database) => {
  db.run("DROP INDEX session_v2_project_time_id_idx")
  db.run("DROP INDEX session_v2_directory_time_id_idx")
  db.run("DROP INDEX session_v2_time_id_idx")
  db.run("CREATE INDEX session_v2_project_idx ON session_v2 (project_id)")
}

const all = (db: Database, sql: string, params: readonly string[]) => {
  const statement = db.prepare(sql)
  try {
    return statement.all(...params)
  } finally {
    statement.finalize()
  }
}

const plan = (db: Database, sql: string, params: readonly string[]) =>
  (all(db, `EXPLAIN QUERY PLAN ${sql}`, params) as { detail: string }[]).map((row) => row.detail)

const results = (db: Database) =>
  Object.values(queries).map(([sql, params]) => all(db, sql, params) as { id: string }[])

const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")

describe("session list indexes", () => {
  test("list plans avoid temp B-tree and results match the pre-migration database", () => {
    const before = new Database(":memory:")
    createTables(before)
    reversePreState(before)
    seed(before, 0, SEED)

    const beforePlans = Object.values(queries).map(([sql, params]) => plan(before, sql, params))
    const beforeHash = hash(results(before).map((rows) => rows.map((row) => row.id)))

    run(migration.up(rawTx(before)))

    const afterPlans = Object.values(queries).map(([sql, params]) => plan(before, sql, params))
    const afterHash = hash(results(before).map((rows) => rows.map((row) => row.id)))

    console.log("before plans", JSON.stringify(beforePlans))
    console.log("after plans", JSON.stringify(afterPlans))
    console.log("before hash", beforeHash, "after hash", afterHash)

    expect(beforePlans.every((detail) => detail.some((line) => line.includes("TEMP B-TREE")))).toBe(true)
    expect(afterPlans.flat().some((line) => line.includes("TEMP B-TREE"))).toBe(false)
    expect(afterPlans[0]!.join(" ")).toContain("session_v2_project_time_id_idx")
    expect(afterPlans[1]!.join(" ")).toContain("session_v2_time_id_idx")
    expect(afterPlans[2]!.join(" ")).toContain("session_v2_directory_time_id_idx")
    expect(afterHash).toBe(beforeHash)
  })

  test("insert cost per 1000 rows, before and after", () => {
    const measure = (shape: (db: Database) => void) => {
      const db = new Database(":memory:")
      createTables(db)
      shape(db)
      seed(db, 0, SEED)
      const start = performance.now()
      seed(db, SEED, 1000)
      return performance.now() - start
    }
    const beforeMs = measure(reversePreState)
    const afterMs = measure(() => undefined)
    console.log("insert 1000 rows ms before", beforeMs.toFixed(2), "after", afterMs.toFixed(2))
    expect(Number.isFinite(afterMs)).toBe(true)
  })

  test("migration applies to an existing database and the schema is the generated one", () => {
    const db = new Database(":memory:")
    createTables(db)
    reversePreState(db)
    seed(db, 0, SEED)
    run(migration.up(rawTx(db)))
    const names = (all(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_v2'", []) as {
      name: string
    }[]).map((row) => row.name)
    expect(names).toContain("session_v2_project_time_id_idx")
    expect(names).toContain("session_v2_directory_time_id_idx")
    expect(names).toContain("session_v2_time_id_idx")
    expect(names).not.toContain("session_v2_project_idx")
    
  })
})
