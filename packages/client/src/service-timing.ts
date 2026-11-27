import { readFileSync } from "node:fs"

export type EnsureTiming = {
  readonly pollInterval: number
  readonly requestTimeout: number
  readonly spawnDelay: number
  readonly maxSpawnDelay: number
  readonly promiseTimeout: number
  readonly stopPollInterval: number
  readonly stopPollAttempts: number
  readonly unresponsiveAfter: number
}

const timings = new WeakMap<object, EnsureTiming>()

// A freshly spawned service registers in ~250 ms, so the poll cadence is a large share of the
// time a client waits for it. Probes are sequential, so the wait between them only matters while
// the connection is refused; both variants give up after promiseTimeout of wall-clock time.
// requestTimeout is generous because a busy host can stall a healthy owner for several seconds.
export const defaultEnsureTiming: EnsureTiming = {
  pollInterval: 25,
  requestTimeout: 10_000,
  spawnDelay: 5_000,
  maxSpawnDelay: 30_000,
  promiseTimeout: 120_000,
  stopPollInterval: 50,
  stopPollAttempts: 100,
  unresponsiveAfter: 60_000,
}

export function ensureTiming(options: object) {
  return timings.get(options) ?? defaultEnsureTiming
}

// Keep test timing out of the public lifecycle option types.
export function withEnsureTiming<A extends object>(options: A, overrides: Partial<EnsureTiming>): A {
  timings.set(options, { ...defaultEnsureTiming, ...overrides })
  return options
}

export type Unresponsive = { readonly since: number; readonly cpu: number | undefined }

// An owner is terminated only when its probes have timed out for unresponsiveAfter of wall-clock
// time and its CPU time did not advance between probes. Advancing CPU means busy, not hung.
// cpu is undefined off Linux, which leaves the wall-clock rule alone.
export function unresponsiveVerdict(
  prior: Unresponsive | undefined,
  now: number,
  cpu: number | undefined,
  timing: EnsureTiming,
) {
  const progressed = prior?.cpu !== undefined && cpu !== undefined && cpu !== prior.cpu
  const since = prior === undefined || progressed ? now : prior.since
  return { since, cpu, terminate: now - since >= timing.unresponsiveAfter }
}

// utime + stime in clock ticks; undefined off Linux or once the process is gone.
export function processCpuTicks(pid: number) {
  if (process.platform !== "linux") return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // Fields after the parenthesised comm: state is index 0, utime 11, stime 12.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return Number(fields[11]) + Number(fields[12])
  } catch {
    return undefined
  }
}
