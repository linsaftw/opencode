// Self-time shares from a V8 .cpuprofile: top functions and subsystem composition.
// Usage: bun scripts/perf/cpuprofile-shares.ts <file.cpuprofile> [topN]
// Idle samples are excluded so percentages are shares of the busy main thread.

type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
type Profile = { nodes: Node[]; samples: number[]; timeDeltas: number[] }

const [file, topArg] = Bun.argv.slice(2)
if (!file) throw new Error("usage: bun scripts/perf/cpuprofile-shares.ts <file.cpuprofile> [topN]")
const top = Number(topArg ?? 15)

const profile = (await Bun.file(file).json()) as Profile
const byID = new Map(profile.nodes.map((node) => [node.id, node]))

const SUBSYSTEMS: Array<[string, RegExp]> = [
  ["GC", /^\(garbage collector\)$/],
  ["projector", /projector/i],
  ["history", /history|message|part/i],
  ["bus", /\/bus\/|bus\.ts|pubsub|PubSub/i],
  ["SSE/event", /\bsse\b|event|stream|heartbeat/i],
  ["sqlite/db", /sqlite|drizzle|database|\/db\//i],
  ["JSON", /^JSON\.|^(parse|stringify)$/],
  ["Effect fiber/layer", /node_modules\/effect|\/effect\/|fiber|runtime|layer/i],
  ["HTTP/server", /node_modules\/(effect\/unstable\/http|@effect\/platform)|http|hono|router/i],
  ["other", /./],
]

// WINDOW_S=10 keeps only samples in the last 10 seconds of the profile (microseconds timeline).
const windowStart = process.env.WINDOW_S
  ? (profile as unknown as { endTime: number }).endTime - Number(process.env.WINDOW_S) * 1e6
  : -Infinity
const selfByNode = new Map<number, number>()
let busy = 0
let idle = 0
let clock = (profile as unknown as { startTime: number }).startTime
profile.samples.forEach((nodeID, index) => {
  const weight = profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0
  clock += profile.timeDeltas[index] ?? 0
  if (clock < windowStart) return
  const name = byID.get(nodeID)?.callFrame.functionName ?? ""
  if (name === "(idle)" || name === "(program)") {
    idle += weight
    return
  }
  busy += weight
  selfByNode.set(nodeID, (selfByNode.get(nodeID) ?? 0) + weight)
})

const byFunction = new Map<string, { self: number; file: string; name: string }>()
for (const [nodeID, self] of selfByNode) {
  const frame = byID.get(nodeID)!.callFrame
  const where = `${frame.url.replace(/^.*\/(packages|node_modules)\//, "$1/")}:${frame.lineNumber + 1}`
  const key = `${frame.functionName || "(anonymous)"} ${where}`
  const entry = byFunction.get(key) ?? { self: 0, file: where, name: frame.functionName || "(anonymous)" }
  entry.self += self
  byFunction.set(key, entry)
}

const pct = (value: number) => ((value / busy) * 100).toFixed(2)
const ranked = [...byFunction.values()].sort((a, b) => b.self - a.self)

const parent = new Map<number, number>()
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
const topNode = [...selfByNode].sort((a, b) => b[1] - a[1])[0]?.[0]
if (topNode !== undefined && process.env.STACK) {
  console.log(`\nAncestor chain of the top self-time node (leaf first)`)
  for (let id: number | undefined = topNode, depth = 0; id !== undefined && depth < 25; id = parent.get(id), depth++) {
    const frame = byID.get(id)!.callFrame
    console.log(`  ${frame.functionName || "(anonymous)"} ${frame.url.replace(/^.*\/(packages|node_modules)\//, "$1/")}:${frame.lineNumber + 1}`)
  }
}

console.log(`busy main-thread time: ${(busy / 1000).toFixed(0)} ms, idle excluded: ${(idle / 1000).toFixed(0)} ms`)
console.log(`\nTop ${top} self-time functions (share of busy main thread)`)
for (const entry of ranked.slice(0, top)) console.log(`${pct(entry.self).padStart(6)}%  ${entry.name}  ${entry.file}`)

const shares = new Map<string, number>()
for (const entry of ranked) {
  const label = SUBSYSTEMS.find(([, pattern]) => pattern.test(entry.name) || pattern.test(entry.file))?.[0] ?? "other"
  shares.set(label, (shares.get(label) ?? 0) + entry.self)
}
console.log(`\nSubsystem composition (heuristic by function name and file)`)
for (const [label, value] of [...shares].sort((a, b) => b[1] - a[1])) console.log(`${pct(value).padStart(6)}%  ${label}`)
