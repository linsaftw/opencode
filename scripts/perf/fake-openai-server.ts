// Offline scripted OpenAI-compatible /v1/chat/completions server for perf runs.
// Per user turn (messages after the last user message): the first two requests stream 200 text
// deltas of 4 chars followed by a `glob` tool call; the third streams 200 deltas and stops.
// Usage: PORT=8771 bun scripts/perf/fake-openai-server.ts   (prints the listening URL)

const encoder = new TextEncoder()
const deltas = Array.from({ length: 200 }, (_, index) => `w${String(index % 10)}${"ab".repeat(1)} `.slice(0, 4))

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  const body = { id: "fake", object: "chat.completion.chunk", created: 0, model: "gpt-4o-mini", choices: [{ index: 0, delta, finish_reason: finish }] }
  return encoder.encode(`data: ${JSON.stringify(body)}\n\n`)
}

function scripted(toolCalls: number) {
  const parts = deltas.map((text) => chunk({ content: text }))
  if (toolCalls > 0) {
    const args = JSON.stringify({ pattern: "*.json", path: "." })
    parts.push(chunk({ tool_calls: [{ index: 0, id: `call_${toolCalls}`, type: "function", function: { name: "glob", arguments: args } }] }))
    parts.push(chunk({}, "tool_calls"))
  } else parts.push(chunk({}, "stop"))
  parts.push(encoder.encode("data: [DONE]\n\n"))
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } })
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await request.json()) as { messages?: Array<{ role: string }> }
    const messages = body.messages ?? []
    const lastUser = messages.findLastIndex((message) => message.role === "user")
    const toolsThisTurn = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length
    return new Response(scripted(toolsThisTurn < 2 ? toolsThisTurn + 1 : 0), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  },
})
console.log(`fake-openai listening at ${server.url}v1`)
