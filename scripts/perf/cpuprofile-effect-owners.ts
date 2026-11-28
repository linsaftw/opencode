// Count-weighted Effect-runtime attribution for a .cpuprofile.
// Usage: bun scripts/perf/cpuprofile-effect-owners.ts <file.cpuprofile> [--window-ms=10000] [--mode=names|owners] [--conversations=400]
// names: inclusive counts of effect-package frames by function name (category discovery).
// owners: inclusive count of effect-tagged samples under each repo frame (packages/**/src), per conversation.
type Frame = { functionName: string; url: string; lineNumber: number }
type Node = { id: number; callFrame: Frame; children?: number[] }
type Profile = { nodes: Node[]; samples: number[]; timeDeltas: number[] }

const [file, ...rest] = Bun.argv.slice(2)
const flags = new Map(rest.map((arg) => arg.replace(/^--/, "").split("=") as [string, string]))
const mode = flags.get("mode") ?? "owners"
const conversations = Number(flags.get("conversations") ?? 400)
const windowUs = Number(flags.get("window-ms") ?? 10000) * 1000

const profile = (await Bun.file(file!).json()) as Profile
const nodeById = new Map(profile.nodes.map((node) => [node.id, node]))
const parent = new Map<number, number>()
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)

const label = (frame: Frame) => `${frame.functionName || "(anonymous)"} ${frame.url.replace(/^.*?(packages\/|node_modules\/)/, "$1")}:${frame.lineNumber + 1}`
const isEffect = (frame: Frame) => /node_modules\/(\.pnpm\/)?(effect|@effect)[^/]*\//.test(frame.url) || /\/effect\/dist\//.test(frame.url) || /effect\.js$/.test(frame.url)
const isRepo = (frame: Frame) => /packages\/[^/]+\/src\//.test(frame.url)

// Walk up from each sample; collect stack frames (leaf to root), limited to the window.
let elapsed = 0
const samples: { frames: Frame[]; w: number }[] = []
for (let index = 0; index < profile.samples.length; index++) {
  elapsed += profile.timeDeltas[index] ?? 0
  if (elapsed > windowUs) break
  const frames: Frame[] = []
  let id: number | undefined = profile.samples[index]
  while (id !== undefined) {
    const node = nodeById.get(id)!
    frames.push(node.callFrame)
    id = parent.get(id)
  }
  if (frames[0]?.functionName === "(idle)") continue
  samples.push({ frames, w: 1 })
}

const total = samples.length
const per = (count: number) => (count / conversations).toFixed(2)
const effectSamples = samples.filter((sample) => sample.frames.some(isEffect))
console.log(`busy samples ${total}, effect-tagged ${effectSamples.length} (${((100 * effectSamples.length) / total).toFixed(1)}%), per conversation ${per(effectSamples.length)} samples`)

if (mode === "names") {
  const counts = new Map<string, number>()
  for (const sample of effectSamples) for (const key of new Set(sample.frames.filter(isEffect).map(label))) counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, Number(flags.get("top") ?? 60)))
    console.log(`${per(count).padStart(8)}/conv  ${key}`)
} else {
  const owners = new Map<string, number>()
  for (const sample of effectSamples) for (const key of new Set(sample.frames.filter(isRepo).map(label))) owners.set(key, (owners.get(key) ?? 0) + 1)
  for (const [key, count] of [...owners].sort((a, b) => b[1] - a[1]).slice(0, Number(flags.get("top") ?? 25)))
    console.log(`${per(count).padStart(8)}/conv  ${key}`)
}

// mode=self: samples whose leaf frame is effect-runtime code, attributed to the nearest repo frame above it.
if (mode === "self") {
  const owners = new Map<string, number>()
  let leafEffect = 0
  for (const sample of samples) {
    if (!isEffect(sample.frames[0]!)) continue
    leafEffect++
    const owner = sample.frames.find(isRepo)
    add(owners, owner ? label(owner) : "(no repo frame)")
  }
  console.log(`effect-leaf samples ${leafEffect} (${per(leafEffect)}/conv)`)
  for (const [key, count] of [...owners].sort((a, b) => b[1] - a[1]).slice(0, Number(flags.get("top") ?? 25)))
    console.log(`${per(count).padStart(8)}/conv  ${key}`)
}
function add(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1)
}
