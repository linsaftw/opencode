// Scoped perf probe: one scripted conversation turn (prompt, 200 streamed text deltas,
// 2 tool calls, persistence) against a real in-memory SQLite database. A counting
// wrapper around the Effect SqlClient records every statement by normalized text.
// PROBE_OUT=<file> writes the statement table and a final table dump as JSON.
import { expect } from "bun:test"
import { Auth, LLMEvent } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { EventTable } from "@opencode/core/event/sql"
import { Permission } from "@opencode/core/permission"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Snapshot } from "@opencode/core/snapshot"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Tool } from "@opencode/core/tool"
import type { Info as ToolInfo } from "@opencode/schema/tool"
import { Form } from "@opencode/core/form"
import { Job } from "@opencode/core/job"
import { SessionTable, SessionMessageTable, SessionPartTable, SessionInboxTable } from "@opencode/core/session/sql"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { SessionStore } from "@opencode/core/session/store"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Model } from "@opencode/core/model"
import { Location } from "@opencode/core/location"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { permissionLayer } from "./lib/permission"
import { writeFileSync } from "node:fs"

const stats = new Map<string, { count: number; ms: number; norm: string }>()
let transactions = 0
let counting = false

const normalize = (sql: string) =>
  sql
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()

const record = (sql: string, ms: number) => {
  if (!counting) return
  const norm = normalize(sql)
  const key = norm.slice(0, 200)
  const entry = stats.get(key) ?? { count: 0, ms: 0, norm }
  entry.count += 1
  entry.ms += ms
  stats.set(key, entry)
}

// Counting wrapper: times the statement path only (unsafe -> values / withoutTransform).
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>, sql: string) =>
  Effect.sync(() => performance.now()).pipe(
    Effect.flatMap((started) =>
      Effect.map(effect, (value) => {
        record(sql, performance.now() - started)
        return value
      }),
    ),
  )

const countingClient = Layer.effect(
  SqlClient.SqlClient,
  Effect.map(
    SqlClient.SqlClient,
    (client) =>
      new Proxy(client, {
        get(target, prop) {
          if (prop === "unsafe")
            return (sql: string, params: ReadonlyArray<unknown>, ...rest: Array<unknown>) => {
              const statement = (target.unsafe as (...args: Array<unknown>) => any)(sql, params, ...rest)
              return new Proxy(statement, {
                get(s, key) {
                  if (key === "values") return timed(s.values, sql)
                  if (key === "withoutTransform") return timed(s.withoutTransform, sql)
                  return Reflect.get(s, key)
                },
              })
            }
          if (prop === "withTransaction")
            return (effect: unknown) => {
              if (counting) transactions += 1
              return (target.withTransaction as (...args: Array<unknown>) => unknown)(effect)
            }
          return Reflect.get(target, prop, target)
        },
      }),
  ),
).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })), Layer.orDie)

const cassetteModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.com/v1" }, auth: Auth.bearer("fixture"), maxTokens: 20, temperature: 0 })
  .model({ id: "gpt-4o-mini", capabilities: { promptCacheKey: true } })
const models = Layer.mock(SessionRunnerModel.Service)({
  select: (session) => Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })),
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(cassetteModel, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 20 },
      }),
    ),
})
const promptModels = Layer.mock(Model.Service, {
  get: () => Effect.undefined,
  all: () => Effect.succeed([]),
  available: () => Effect.succeed([]),
  default: () => Effect.undefined,
  small: () => Effect.undefined,
})
const systemContext = Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })
const instructionContext = Layer.mock(InstructionDiscovery.Service, {
  project: true,
  global: true,
  claude: true,
  load: () => Effect.succeed(Instructions.empty),
})
const permission = permissionLayer()
const config = Config.testLayer()

const echo = Layer.effectDiscard(
  Tool.Service.use((registry) =>
    registry.transform((editor) => {
      const tools: Record<string, ToolInfo> = {
        echo: {
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }: { readonly text: string }) => Effect.succeed({ output: { text }, content: text }),
        } as unknown as ToolInfo,
      }
      Object.entries(tools).forEach(([name, tool]) => editor.add({ ...tool, name, options: { codemode: false } }))
    }),
  ),
)
const echoNode = makeLocationNode({ name: "perf/echo-tool", layer: echo, deps: [Tool.node] })

const llm = TestLLM.testLayer({ fallback: [] })
const testLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Bus.node,
    SessionProjector.node,
    SessionStore.node,
    SessionInbox.node,
    Agent.node,
    Model.node,
    PluginHooks.node,
    Tool.node,
    Form.node,
    Job.node,
    echoNode,
    SessionRunnerModel.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    SkillInstructions.node,
    ReferenceInstructions.node,
    Config.node,
    Snapshot.node,
    SessionCompaction.node,
    LayerNodePlatform.llmClient,
    SessionRunnerLLM.node,
    SessionExecution.node,
    Session.node,
  ]),
  [
    Database.node.replace(Database.configuredClient(countingClient)),
    Bus.node.replace(Bus.configured({ persist: true })),
    LayerNodePlatform.llmClient.replace(llm),
    LocationServiceMap.node.replace(promptLocationNode),
    Model.node.replace(promptModels),
    SessionRunnerModel.node.replace(models),
    InstructionBuiltIns.node.replace(systemContext),
    InstructionDiscovery.node.replace(instructionContext),
    Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })),
    ReferenceInstructions.node.replace(
      Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
    ),
    McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })),
    Config.node.replace(config),
    Permission.node.replace(permission),
    Snapshot.node.replace(Snapshot.noopLayer),
    PluginSupervisor.node.replace(Layer.empty),
    Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
  ],
)
const layer = testLayer.pipe(Layer.provideMerge(llm))
const it = testEffect(layer)
const sessionID = Session.ID.make("ses_perf_turn")
const TEXT_DELTAS = 200

const turnResponses = () => {
  const deltas = Array.from({ length: TEXT_DELTAS }, () => LLMEvent.textDelta({ id: "text-1", text: "abcd" }))
  return [
    TestLLM.toolCalls(
      LLMEvent.toolCall({ id: "call_1", name: "echo", input: { text: "one" } }),
      LLMEvent.toolCall({ id: "call_2", name: "echo", input: { text: "two" } }),
    ),
    TestLLM.stop(LLMEvent.textStart({ id: "text-1" }), ...deltas, LLMEvent.textEnd({ id: "text-1" })),
  ]
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: "/project",
      title: "perf",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const turn = Effect.gen(function* () {
  const session = yield* Session.Service
  yield* session.prompt({ sessionID, text: "list files and summarize", resume: false })
  yield* session.resume(sessionID)
})

const dumpTables = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const sessions = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
  const messages = yield* db.select().from(SessionMessageTable).all().pipe(Effect.orDie)
  const parts = yield* db.select().from(SessionPartTable).orderBy(asc(SessionPartTable.message_id), asc(SessionPartTable.ordinal)).all().pipe(Effect.orDie)
  const inbox = yield* db.select().from(SessionInboxTable).all().pipe(Effect.orDie)
  const events = yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  return { sessions, messages, parts, inbox, events }
})

it.effect(
  "perf probe: one scripted conversation turn, statement table",
  () =>
      Effect.gen(function* () {
        yield* setup
        const tl = yield* TestLLM.Test
        yield* tl.push(TestLLM.text("warm", "text-warm"))
        yield* turn
        for (const response of turnResponses()) yield* tl.push(response)

        Bun.gc(true)
        const heapBefore = process.memoryUsage().heapUsed
        stats.clear()
        transactions = 0
        counting = true
        const started = performance.now()
        yield* turn
        const wallMs = performance.now() - started
        counting = false
        Bun.gc(true)
        const heapAfter = process.memoryUsage().heapUsed

        const rows = [...stats.values()]
          .map((row) => ({ class: classOf(row.norm), count: row.count, ms: Number(row.ms.toFixed(3)), norm: row.norm }))
          .sort((a, b) => b.ms - a.ms)
        const totalMs = rows.reduce((sum, row) => sum + row.ms, 0)
        const totalCount = rows.reduce((sum, row) => sum + row.count, 0)
        const dump = yield* dumpTables
        const summary = { totalCount, totalMs: Number(totalMs.toFixed(3)), transactions, wallMs, heapBefore, heapAfter, rows, dump }
        const out = process.env.PROBE_OUT
        if (out) writeFileSync(out, JSON.stringify(summary, null, 2))
        console.log(
          rows
            .map((row) => `${(row.ms / totalMs * 100).toFixed(1).padStart(5)}% ${row.ms.toFixed(2).padStart(8)}ms x${row.count} ${row.norm.slice(0, 140)}`)
            .join("\n") + `\nTOTAL statements=${totalCount} ms=${totalMs.toFixed(2)} tx=${transactions} wall=${wallMs.toFixed(1)} heapDelta=${heapAfter - heapBefore}`,
        )
        // Regression guard for the bus duplicate-id check folded into the event insert (was 22 pre-selects).
        expect(totalCount).toBeLessThanOrEqual(141)
        expect(transactions).toBeLessThanOrEqual(24)
        expect(dump.events.length).toBeGreaterThan(0)
        expect(dump.messages.length).toBeGreaterThan(0)
      }),
  120_000,
)

const classOf = (norm: string) => {
  const verb = norm.split(" ")[0]
  const table = norm.match(/(?:FROM|INTO|UPDATE|TABLE) ("?[a-z_]+"?)/i)?.[1] ?? ""
  return `${verb} ${table}`.trim()
}
