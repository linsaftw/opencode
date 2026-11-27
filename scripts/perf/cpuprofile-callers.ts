// Call-tree attribution for a .cpuprofile: per top self-time frame, inclusive %, top callers and callees,
// and the repo-owned (packages/**/src) frames that own time under a given wrapper frame.
// Usage: bun scripts/perf/cpuprofile-callers.ts <file.cpuprofile> [--top=10] [--callers=5] [--wrapper=platform-node-shared/dist/internal/utils.js] [--owners=8]

type Frame = { functionName: string; url: string; lineNumber: number }
type Node = { id: number; callFrame: Frame; children?: number[] }
type Profile = { nodes: Node[]; samples: number[]; timeDeltas: number[] }

const [file, ...rest] = Bun.argv.slice(2)
const flags = new Map(rest.map((arg) => arg.replace(/^--/, "").split("=") as [string, string]))
const top = Number(flags.get("top") ?? 10)
const callerCount = Number(flags.get("callers") ?? 5)
const ownerCount = Number(flags.get("owners") ?? 8)
const wrapperMatch = flags.get("wrapper") ?? "platform-node-shared/dist/internal/utils.js"

const profile = (await Bun.file(file!).json()) as Profile
const nodeById = new Map(profile.nodes.map((node) => [node.id, node]))
const parent = new Map<number, number>()
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)

// Sample duration = delta to the next sample (Chrome stores each delta before its sample).
// --weight=count uses one unit per sample (immune to single-sample gaps) instead of duration.
const weight = (index: number) => (flags.get("weight") === "count" ? 1 : (profile.timeDeltas[index + 1] ?? 0))
const label = (frame: Frame) =>
  `${frame.functionName || "(anonymous)"} ${frame.url.replace(/^.*?(packages\/|node_modules\/)/, "$1")}:${frame.lineNumber + 1}`

const stackMemo = new Map<number, string[]>()
function stackOf(nodeID: number): string[] {
  const memo = stackMemo.get(nodeID)
  if (memo) return memo
  const node = nodeById.get(nodeID)!
  const up = parent.has(nodeID) ? stackOf(parent.get(nodeID)!) : []
  const stack = [...up, label(node.callFrame)]
  stackMemo.set(nodeID, stack)
  return stack
}

const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value)
const pct = (value: number, total: number) => `${((100 * value) / total).toFixed(2)}%`
const busy = profile.samples.map((nodeID, index) => ({ stack: stackOf(nodeID), w: weight(index), at: profile.timeDeltas.slice(0, index + 1).reduce((sum, delta) => sum + delta, 0), leaf: label(nodeById.get(nodeID)!.callFrame) }))
  .filter((sample) => !sample.stack[sample.stack.length - 1]!.startsWith("(idle)"))
const total = busy.reduce((sum, sample) => sum + sample.w, 0)
// Sampling gaps: one sample can span seconds (profiler stall); its leaf gets all of that time.
const gaps = busy.filter((sample) => sample.w > 50_000).sort((a, b) => b.w - a.w)
const gapWeight = gaps.reduce((sum, sample) => sum + sample.w, 0)
console.log(`gap samples >50 ms: ${gaps.length}, carrying ${pct(gapWeight, total)} of busy time`)
for (const sample of gaps.slice(0, 3)) console.log(`  gap ${(sample.w / 1000).toFixed(0)} ms at ${((sample.at - profile.timeDeltas[0]!) / 1_000_000).toFixed(1)} s leaf ${sample.leaf}`)

const self = new Map<string, number>()
const inclusive = new Map<string, number>()
for (const sample of busy) {
  add(self, sample.leaf, sample.w)
  for (const key of new Set(sample.stack)) add(inclusive, key, sample.w)
}
const topSelf = [...self].sort((a, b) => b[1] - a[1]).slice(0, top)
console.log(`busy ${(total / 1000).toFixed(0)} ms, samples ${busy.length}`)

for (const [key, value] of topSelf) {
  console.log(`\nSELF ${pct(value, total)}  INCL ${pct(inclusive.get(key) ?? 0, total)}  ${key}`)
  const callers = new Map<string, number>()
  const callees = new Map<string, number>()
  for (const sample of busy) {
    const at = sample.stack.lastIndexOf(key)
    if (at < 0) continue
    add(callers, sample.stack[at - 1] ?? "(root)", sample.w)
    add(callees, sample.stack[at + 1] ?? "(self)", sample.w)
  }
  for (const [title, map] of [["caller", callers], ["callee", callees]] as const) {
    for (const [name, value] of [...map].sort((a, b) => b[1] - a[1]).slice(0, callerCount)) {
      console.log(`  ${title} ${pct(value, total)}  ${name}`)
    }
  }
}

const wrapperSamples = busy.filter((sample) => sample.stack.some((key) => key.includes(wrapperMatch)))
const wrapperWeight = wrapperSamples.reduce((sum, sample) => sum + sample.w, 0)
console.log(`\nWRAPPER ${wrapperMatch}: incl ${pct(wrapperWeight, total)} (${wrapperSamples.length} samples)`)

const owners = new Map<string, number>()
const ownerPattern = /packages\/[^ ]*\/src\//
for (const sample of wrapperSamples) {
  for (const key of new Set(sample.stack.filter((item) => ownerPattern.test(item)))) add(owners, key, sample.w)
}
console.log(`OWNERS (repo src frames under wrapper, inclusive % of busy; % of wrapper)`)
for (const [key, value] of [...owners].sort((a, b) => b[1] - a[1]).slice(0, ownerCount)) {
  console.log(`  ${pct(value, total)}  ${pct(value, wrapperWeight)}  ${key}`)
}
