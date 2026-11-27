// Count-weighted steady-state composition of a .cpuprofile window.
// Usage: bun scripts/perf/cpuprofile-composition.ts <file.cpuprofile> [--window-ms=5400] [--top=25] [--inclusive=15]
// Crops samples to the first window-ms of the profile timeline, drops idle/program samples, then reports
// self top-N, inclusive repo (packages/**/src) top-N (each sample counted once per function), and subsystem shares.

type Frame = { functionName: string; url: string; lineNumber: number }
type Node = { id: number; callFrame: Frame; children?: number[] }
type Profile = { startTime: number; nodes: Node[]; samples: number[]; timeDeltas: number[] }

const [file, ...rest] = Bun.argv.slice(2)
const flags = new Map(rest.map((arg) => arg.replace(/^--/, "").split("=") as [string, string]))
const windowMs = Number(flags.get("window-ms") ?? Infinity)
const top = Number(flags.get("top") ?? 25)
const inclusiveTop = Number(flags.get("inclusive") ?? 15)

const profile = (await Bun.file(file!).json()) as Profile
const nodeById = new Map(profile.nodes.map((node) => [node.id, node]))
const parent = new Map<number, number>()
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)

const idleNames = new Set(["(idle)", "(program)", "(root)"])
const stackOf = (nodeID: number) => {
  const frames: Frame[] = []
  for (let id: number | undefined = nodeID; id !== undefined; id = parent.get(id)) {
    const node = nodeById.get(id)
    if (node) frames.push(node.callFrame)
  }
  return frames
}
const label = (frame: Frame) => `${frame.functionName || "(anonymous)"} ${frame.url.replace(/^.*?(packages\/|node_modules\/)/, "$1")}:${frame.lineNumber + 1}`
const repoOf = (frame: Frame) => frame.url.match(/packages\/([^/]+)\/src\//)?.[1]
const repoLabel = (frame: Frame) => frame.url.replace(/^.*?(packages\/)/, "$1").replace(/^(packages\/[^/]+\/src\/[^:]*)$/, "$1")

// Subsystem of a sample: first (leaf-most) frame that matches a rule.
const subsystemRules: [RegExp, string][] = [
  [/\/packages\/(core|database)\/|packages\/core\//, "repo:core"],
  [/packages\/(server|protocol)\//, "repo:server/protocol"],
  [/packages\/(cli|tui|app|sdk|client|schema|util|llm|plugin)\//, "repo:other"],
  [/drizzle|sql-sqlite|sqlite|SqliteClient/i, "sqlite/db"],
  [/node_modules\/effect\/|@effect\/(?!platform-node-shared\/dist\/internal\/utils)|effect\/dist/, "Effect runtime"],
  [/node:http|_http|http\.js|node:net|hono|h3|platform-node-shared|undici|writeAll|clearServerParserIncoming/, "HTTP/server"],
  [/JSON|json|structuredClone|JSON\.parse/, "JSON"],
  [/node:async_hooks|async_hooks/, "async_hooks"],
]
const subsystemOf = (frames: Frame[]) => {
  for (const frame of frames) {
    const text = `${frame.url} ${frame.functionName}`
    const hit = subsystemRules.find(([pattern]) => pattern.test(text))
    if (hit) return hit[1]
  }
  return "other"
}

const selfCount = new Map<string, number>()
const inclusiveCount = new Map<string, number>()
const subsystemCount = new Map<string, number>()
const repoCount = new Map<string, number>()
let elapsedUs = 0
let windowSamples = 0
let busy = 0
for (let index = 0; index < profile.samples.length; index++) {
  elapsedUs += profile.timeDeltas[index] ?? 0
  if (elapsedUs / 1000 > windowMs) break
  windowSamples++
  const frames = stackOf(profile.samples[index]!)
  const leaf = frames[0]
  if (!leaf || idleNames.has(leaf.functionName)) continue
  busy++
  const self = label(leaf)
  selfCount.set(self, (selfCount.get(self) ?? 0) + 1)
  const subsystem = subsystemOf(frames)
  subsystemCount.set(subsystem, (subsystemCount.get(subsystem) ?? 0) + 1)
  const seen = new Set<string>()
  for (const frame of frames) {
    if (!repoOf(frame)) continue
    const key = `${label(frame)}`
    if (seen.has(key)) continue
    seen.add(key)
    inclusiveCount.set(key, (inclusiveCount.get(key) ?? 0) + 1)
  }
  const repo = frames.map(repoOf).find((value) => value !== undefined)
  if (repo) repoCount.set(repo, (repoCount.get(repo) ?? 0) + 1)
}

const pct = (count: number) => `${((count / busy) * 100).toFixed(1)}%`
const rank = (map: Map<string, number>, limit: number) =>
  [...map].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => `${pct(count)} ${name}`)

console.log(JSON.stringify({ windowMs, windowSamples, busySamples: busy }))
console.log("SELF top", top)
console.log(rank(selfCount, top).join("\n"))
console.log("INCLUSIVE repo top", inclusiveTop)
console.log(rank(inclusiveCount, inclusiveTop).join("\n"))
console.log("SUBSYSTEM (leaf-most matching frame)")
console.log(rank(subsystemCount, 20).join("\n"))
console.log("REPO package (inclusive, first repo frame from leaf)")
console.log(rank(repoCount, 20).join("\n"))
