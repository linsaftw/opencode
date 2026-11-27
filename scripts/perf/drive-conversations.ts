// Drives N scripted conversations through the public HTTP API with an SSE client attached.
// Pairs with scripts/perf/fake-openai-server.ts (provider) and a server started with an OpenAI-compatible provider.
// Usage: bun scripts/perf/drive-conversations.ts <serverBaseURL> [conversations=3]

const [base = "http://127.0.0.1:8772", countArg] = Bun.argv.slice(2)
const conversations = Number(countArg ?? 3)
const password = process.env.OPENCODE_SERVER_PASSWORD ?? ""
const auth = { authorization: `Basic ${btoa(`opencode:${password}`)}` }
const json = { "content-type": "application/json", ...auth }

const sse = { events: 0, bytes: 0 }
const controller = new AbortController()
const stream = fetch(`${base}/api/event`, { signal: controller.signal, headers: { accept: "text/event-stream", ...auth } })
  .then(async (response) => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      sse.bytes += value.byteLength
      sse.events += decoder.decode(value).split("\n\n").length - 1
    }
  })
  .catch(() => undefined)

const created = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ title: "perf-composition", model: { id: "gpt-4o-mini", providerID: "openai" } }),
}).then((response) => response.json() as Promise<{ data: { id: string } }>)
const sessionID = created.data.id

const timings: number[] = []
const finishedAt: number[] = []
for (let index = 0; index < conversations; index++) {
  const started = performance.now()
  const prompt = await fetch(`${base}/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ text: `conversation ${index + 1}: list the json files` }),
  })
  if (!prompt.ok) throw new Error(`prompt ${index + 1} failed: ${prompt.status} ${await prompt.text()}`)
  const wait = await fetch(`${base}/api/experimental/session/${sessionID}/wait`, { method: "POST", headers: auth })
  if (!wait.ok) throw new Error(`wait ${index + 1} failed: ${wait.status} ${await wait.text()}`)
  timings.push(Math.round(performance.now() - started))
  finishedAt.push(Date.now())
}

const messages = (await fetch(`${base}/api/session/${sessionID}/message`, { headers: auth }).then((response) => response.json())) as {
  data?: unknown[]
}
controller.abort()
await stream

console.log(JSON.stringify({ sessionID, conversationMs: timings, finishedAt, persistedMessages: messages.data?.length ?? null, sse }))
