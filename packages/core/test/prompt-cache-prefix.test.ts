import { describe, expect } from "bun:test"
import { Message, SystemPart, ToolCallPart, ToolDefinition, ToolResultPart } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import type { SessionRequestMessage } from "@opencode/plugin/effect/session"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const session = Session.Info.make({
  id: Session.ID.make("ses_prompt_cache_prefix"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})
const system = [
  SystemPart.make(
    "You are OpenCode, a coding agent that reads the project before editing it. Answer with the smallest change " +
      "that fixes the request, keep the existing style, and never claim a check you did not run.",
  ),
]
const tools = {
  definitions: [
    new ToolDefinition({
      name: "read",
      description: "Read a file from the project",
      inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
    }),
    new ToolDefinition({
      name: "grep",
      description: "Search file contents in the project",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    }),
  ],
  execute: () => Effect.die("unused tool execution"),
}

const TURN_COUNT = 32

// One turn of a real session: the user asks, the assistant answers, and every other turn runs a tool first.
const turn = (index: number): Array<SessionRequestMessage> => {
  const user = Message.user(
    `Turn ${index}: walk me through how the runner resolves the agent for this request and what changes in ` +
      `src/session/runner/step.ts when the turn carries a tool call. Keep the answer short and cite the file.`,
  )
  if (index % 2 === 0)
    return [
      user,
      Message.assistant(
        `Turn ${index}: the runner resolves the agent from the session and passes the resolved model into the ` +
          `request builder, so a tool call and a plain reply share the same prompt prefix.`,
      ),
    ]
  return [
    user,
    Message.assistant([
      Message.text(`Turn ${index}: let me check the file before answering.`),
      ToolCallPart.make({
        id: `call_${index}`,
        name: "read",
        input: { filePath: `/project/src/session/runner/step-${index}.ts` },
      }),
    ]),
    Message.tool(
      ToolResultPart.make({
        id: `call_${index}`,
        name: "read",
        result: `Turn ${index} file contents: the step builds one request per call and continues from the reloaded history.`,
        resultType: "text",
      }),
    ),
  ]
}

const conversation = () => Array.from({ length: TURN_COUNT }, (_, index) => turn(index + 1)).flat()

// A prefix cache sees the provider payload, so serialize exactly the fields the prompt is built from.
const serialize = (request: SessionModelRequest.Prepared["request"]) =>
  JSON.stringify({ system: request.system, tools: request.tools, messages: request.messages })

const commonPrefix = (previous: string, next: string) => {
  const limit = Math.min(previous.length, next.length)
  let index = 0
  while (index < limit && previous.charCodeAt(index) === next.charCodeAt(index)) index++
  return index
}

// A prefix cache bills the shared leading bytes as a hit. Tokens are about bytes / 4 on both sides, so the byte
// ratio is the token ratio.
const prefixRatio = (previous: string, next: string) => {
  const shared = commonPrefix(previous, next)
  return Buffer.byteLength(next.slice(0, shared)) / Buffer.byteLength(next)
}

describe("SessionModelRequest prompt cache prefix", () => {
  it.effect("keeps the serialized prompt prefix across an appended turn and an identical repeat", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const build = (messages: Array<SessionRequestMessage>) =>
        requests
          .primary({ session, agent: Agent.ID.make("build"), model, system, messages, tools })
          .pipe(Effect.map((prepared) => serialize(prepared.request)))

      const history = conversation()
      const previous = yield* build(history)
      const repeat = yield* build(history)
      const appended = yield* build([...history, ...turn(TURN_COUNT + 1)])

      // The same conversation must serialize byte for byte, or the provider cannot reuse its cache at all.
      expect(prefixRatio(previous, repeat)).toBeGreaterThanOrEqual(0.999)
      // A new turn only appends to the end; the system prompt, tool schemas and earlier messages stay identical.
      expect(prefixRatio(previous, appended)).toBeGreaterThanOrEqual(0.95)
      expect(appended.length).toBeGreaterThan(previous.length)
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )
})
