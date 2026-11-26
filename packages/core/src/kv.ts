export * as KV from "./kv.js"

import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KVTable } from "./kv/sql.js"

export type Value = Schema.Json

export interface Entry {
  readonly key: string
  readonly value: Value
}

export interface ScanOptions {
  readonly prefix: string
  readonly after?: string
  readonly limit?: number
}

export interface ScanResult {
  readonly entries: readonly Entry[]
  readonly next?: string
}

export interface Interface {
  readonly get: (key: string) => Effect.Effect<Value | undefined>
  readonly set: (key: string, value: Value) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly scan: (options: ScanOptions) => Effect.Effect<ScanResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KV") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    // Built once per layer: query building is a measurable share of idle service time. Placeholders carry the
    // per-call values without rebuilding the SQL. Timestamps are explicit because a prepared INSERT would freeze
    // the column's `$default` at prepare time.
    const getQuery = db
      .select({ value: KVTable.value })
      .from(KVTable)
      .where(eq(KVTable.key, sql.placeholder("key")))
      .prepare()
    const setQuery = db
      .insert(KVTable)
      .values({
        key: sql.placeholder("key"),
        value: sql.placeholder("value"),
        time_created: sql.placeholder("time_created"),
        time_updated: sql.placeholder("time_updated"),
      })
      .onConflictDoUpdate({
        target: KVTable.key,
        set: { value: sql.placeholder("value"), time_updated: sql.placeholder("time_updated") },
      })
      .prepare()
    const removeQuery = db
      .delete(KVTable)
      .where(eq(KVTable.key, sql.placeholder("key")))
      .prepare()
    return Service.of({
      get: Effect.fn("KV.get")(function* (key) {
        return (yield* getQuery.get({ key }).pipe(Effect.orDie))?.value
      }),
      set: Effect.fn("KV.set")(function* (key, value) {
        const now = Date.now()
        yield* setQuery.run({ key, value, time_created: now, time_updated: now }).pipe(Effect.orDie)
      }),
      remove: Effect.fn("KV.remove")(function* (key) {
        yield* removeQuery.run({ key }).pipe(Effect.orDie)
      }),
      scan: Effect.fn("KV.scan")(function* (options) {
        const limit = Number.isNaN(options.limit) ? 100 : Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 1000)
        const end = prefixEnd(options.prefix)
        const rows = yield* db
          .select({ key: KVTable.key, value: KVTable.value })
          .from(KVTable)
          .where(
            and(
              options.prefix === "" ? undefined : gte(KVTable.key, options.prefix),
              end === undefined ? undefined : lt(KVTable.key, end),
              options.after === undefined ? undefined : gt(KVTable.key, options.after),
            ),
          )
          .orderBy(asc(KVTable.key))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        const entries = rows.slice(0, limit)
        if (rows.length <= limit) return { entries }
        return { entries, next: entries[entries.length - 1].key }
      }),
    })
  }),
)

function prefixEnd(prefix: string) {
  const points = Array.from(prefix)
  const index = points.findLastIndex((value) => value.codePointAt(0)! < 0x10ffff)
  if (index < 0) return undefined
  return `${points.slice(0, index).join("")}${String.fromCodePoint(points[index].codePointAt(0)! + 1)}`
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
