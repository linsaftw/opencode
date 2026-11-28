// Noise-independent A/B of sample COUNTS across cpuprofile dirs (one dir per condition).
// Usage: bun scripts/perf/cpuprofile-count-diff.ts <dirA> <dirB> [--top=10] [--interval-us=500] [--filter=<regex>]
// Each function (name + url:line) is counted once per sample it appears in (inclusive).
// Prints mean samples per profile for A and B, delta = B - A, and delta x interval in CPU ms.

type Frame = { functionName: string; url: string; lineNumber: number }
type Node = { id: number; callFrame: Frame; children?: number[] }
type Profile = { nodes: Node[]; samples: number[] }

const [dirA, dirB, ...rest] = Bun.argv.slice(2)
const flags = new Map(rest.map((arg) => arg.replace(/^--/, "").split("=") as [string, string]))
const top = Number(flags.get("top") ?? 10)
const intervalUs = Number(flags.get("interval-us") ?? 500)
const filter = new RegExp(flags.get("filter") ?? ".")
const idle = new Set(["(idle)", "(program)", "(root)"])

async function profilesIn(dir: string) {
  const { readdir } = await import("node:fs/promises")
  const files = (await readdir(dir)).filter((name) => name.endsWith(".cpuprofile")).sort()
  return files.map((name) => `${dir}/${name}`)
}

function countsOf(profile: Profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const counts = new Map<string, number>()
  for (const sample of profile.samples) {
    const seen = new Set<string>()
    for (let id: number | undefined = sample; id !== undefined; id = parent.get(id)) {
      const frame = byId.get(id)?.callFrame
      if (!frame || idle.has(frame.functionName)) continue
      const url = frame.url.replace(/^file:\/\//, "").replace(/^.*?(packages\/[^/]+\/src\/|node_modules\/)/, "$1")
      const label = `${frame.functionName || "(anonymous)"} ${url}:${frame.lineNumber + 1}`
      if (!filter.test(label) || seen.has(label)) continue
      seen.add(label)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }
  return counts
}

async function meanCounts(dir: string) {
  const files = await profilesIn(dir)
  const sums = new Map<string, number>()
  for (const file of files) {
    const counts = countsOf((await Bun.file(file).json()) as Profile)
    for (const [label, count] of counts) sums.set(label, (sums.get(label) ?? 0) + count)
  }
  return { n: files.length, means: new Map([...sums].map(([label, sum]) => [label, sum / files.length])) }
}

const a = await meanCounts(dirA!)
const b = await meanCounts(dirB!)
const labels = new Set([...a.means.keys(), ...b.means.keys()])
const rows = [...labels]
  .map((label) => {
    const meanA = a.means.get(label) ?? 0
    const meanB = b.means.get(label) ?? 0
    return { label, meanA, meanB, delta: meanB - meanA }
  })
  .sort((x, y) => y.delta - x.delta)

console.log(`profiles A=${a.n} B=${b.n} interval=${intervalUs}us`)
console.log("delta_ms\tdelta_samples\tmean_A\tmean_B\tfunction")
for (const row of rows.slice(0, top)) {
  console.log(
    `${((row.delta * intervalUs) / 1000).toFixed(1)}\t${row.delta.toFixed(1)}\t${row.meanA.toFixed(1)}\t${row.meanB.toFixed(1)}\t${row.label}`,
  )
}
