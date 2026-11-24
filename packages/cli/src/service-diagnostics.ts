/** Privacy-safe diagnostics for the background service process.
 *
 * Records only identifiers, versions, process IDs, counters and coarse reasons. URLs (which can
 * carry credentials), passwords, session IDs and session content are never included. File
 * descriptor targets are reduced to category counts before they leave the sampler: raw paths
 * (which can contain user names or project details) are never logged.
 */

import { readdir, readlink } from "node:fs/promises"
import { join } from "node:path"

export const HEARTBEAT_INTERVAL = "5 minutes"
// Millisecond companion to HEARTBEAT_INTERVAL for stall thresholds; keep the two in sync.
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000
export const STALL_GAP_FACTOR = 2
export const STALL_THRESHOLD_MS = STALL_GAP_FACTOR * HEARTBEAT_INTERVAL_MS

/** Counts only; never holds a raw descriptor target such as a database path. */
export type FdBreakdown = {
  total: number
  contextDb: number
  contextDbWal: number
  contextDbShm: number
  inotify: number
  pidfd: number
  sockets: number
  pipes: number
  other: number
}

export type ServiceMeta = {
  readonly pid: number
  readonly version: string
  readonly registrationID: string
  readonly port?: number
}

export type ShutdownReason =
  | "server-shutdown"
  | "signal"
  | "registration-replaced"
  | "uncaught-exception"
  | "unhandled-rejection"
  | "error"

export type Lifecycle = {
  readonly meta: ServiceMeta
  readonly startedAt: number
  // Mutable so the state returned by begin() stays current when a handler notes a shutdown.
  reason: ShutdownReason
  signal?: NodeJS.Signals
  exitCode?: number
}

let current: Lifecycle | undefined

/** Begin diagnostics for this process; returns the state used by the pure field builders. */
export function begin(meta: ServiceMeta, now = Date.now()): Lifecycle {
  current = { meta, startedAt: now, reason: "server-shutdown", exitCode: 0 }
  return current
}

/** Hook for existing CLI signal handlers; a no-op outside a background service process. */
export function noteShutdown(reason: ShutdownReason, signal?: NodeJS.Signals) {
  if (current === undefined) return
  current.reason = reason
  if (signal !== undefined) {
    current.signal = signal
    // runMain maps SIGTERM to 143 and SIGINT to 130 (see index.ts).
    if (signal === "SIGTERM") current.exitCode = 143
    if (signal === "SIGINT") current.exitCode = 130
  }
}

/** Hook for the existing uncaught-error handlers; a no-op outside a background service process. */
export function noteError(reason: "uncaught-exception" | "unhandled-rejection") {
  noteShutdown(reason)
  if (current !== undefined) current.exitCode = 1
}

export function startedFields(state: Lifecycle) {
  return {
    event: "service.process.started",
    pid: state.meta.pid,
    version: state.meta.version,
    registrationID: state.meta.registrationID,
    port: state.meta.port ?? null,
  }
}

export function shutdownFields(state: Lifecycle, now = Date.now()) {
  return {
    event: "service.process.shutdown",
    pid: state.meta.pid,
    version: state.meta.version,
    registrationID: state.meta.registrationID,
    reason: state.reason,
    signal: state.signal ?? null,
    uptimeSeconds: uptimeSeconds(state, now),
  }
}

/** Fields for the active service process, for handlers that cannot hold the lifecycle state. */
export function currentShutdownFields(now = Date.now()) {
  return current === undefined ? undefined : shutdownFields(current, now)
}

export function exitFields(state: Lifecycle, exitCode: number | null = state.exitCode ?? null, now = Date.now()) {
  return {
    event: "service.process.exit",
    pid: state.meta.pid,
    version: state.meta.version,
    registrationID: state.meta.registrationID,
    reason: state.reason,
    signal: state.signal ?? null,
    exitCode,
    uptimeSeconds: uptimeSeconds(state, now),
  }
}

export function heartbeatFields(
  state: Lifecycle,
  address: string,
  memory: NodeJS.MemoryUsage,
  now = Date.now(),
  fd?: FdBreakdown,
  previousFdCount?: number,
) {
  return {
    event: "service.heartbeat",
    pid: state.meta.pid,
    version: state.meta.version,
    registrationID: state.meta.registrationID,
    port: state.meta.port ?? null,
    address,
    uptimeSeconds: uptimeSeconds(state, now),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    fdCount: fd?.total ?? null,
    fdBreakdown: fd ?? null,
    fdPreviousCount: previousFdCount ?? null,
    fdGrowth: fd !== undefined && previousFdCount !== undefined ? fd.total - previousFdCount : null,
  }
}

/** Reads /proc/self/fd asynchronously and returns coarse counts, or undefined off Linux/on error. */
export async function sampleFileDescriptors(directory = "/proc/self/fd"): Promise<FdBreakdown | undefined> {
  if (process.platform !== "linux") return undefined
  try {
    const entries = await readdir(directory)
    const targets = await Promise.all(entries.map((entry) => readlink(join(directory, entry))))
    return categorizeFdTargets(targets)
  } catch {
    return undefined
  }
}

/** Pure helper: group readlink targets into privacy-safe counts. */
export function categorizeFdTargets(targets: readonly string[]): FdBreakdown {
  const breakdown: FdBreakdown = {
    total: targets.length,
    contextDb: 0,
    contextDbWal: 0,
    contextDbShm: 0,
    inotify: 0,
    pidfd: 0,
    sockets: 0,
    pipes: 0,
    other: 0,
  }
  for (const target of targets) breakdown[fdCategory(target)]++
  return breakdown
}

function fdCategory(target: string): Exclude<keyof FdBreakdown, "total"> {
  if (target === "anon_inode:inotify") return "inotify"
  if (target === "anon_inode:[pidfd]") return "pidfd"
  if (target.startsWith("socket:")) return "sockets"
  if (target.startsWith("pipe:")) return "pipes"
  // Linux appends " (deleted)" to readlink results for unlinked files, including WAL files.
  const name = target.slice(target.lastIndexOf("/") + 1).replace(/ \(deleted\)$/, "")
  if (name === "context.db") return "contextDb"
  if (name === "context.db-wal") return "contextDbWal"
  if (name === "context.db-shm") return "contextDbShm"
  return "other"
}

/** Gap between two actual heartbeat ticks; a stalled loop resumes with a larger gap. */
export function stallGapMs(previousTickAt: number, currentTickAt: number): number {
  return Math.max(0, currentTickAt - previousTickAt)
}

/** True only when consecutive ticks were more than twice the configured interval apart. */
export function isStalledGap(gapMs: number, thresholdMs = STALL_THRESHOLD_MS): boolean {
  return gapMs > thresholdMs
}

/** Emitted once the event loop resumes after a missing heartbeat; counts only, no targets. */
export function stallWarningFields(
  state: Lifecycle,
  memory: NodeJS.MemoryUsage,
  fd: FdBreakdown | undefined,
  gapMs: number,
  now = Date.now(),
) {
  return {
    event: "service event loop stalled",
    pid: state.meta.pid,
    version: state.meta.version,
    registrationID: state.meta.registrationID,
    gapMs,
    thresholdMs: STALL_THRESHOLD_MS,
    uptimeSeconds: uptimeSeconds(state, now),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    fdCount: fd?.total ?? null,
    fdBreakdown: fd ?? null,
  }
}

/** Emitted when a service writes or replaces the registration file. */
export function registrationFields(input: {
  readonly previousPID?: number
  readonly previousID?: string
  readonly previousVersion?: string
  readonly newPID: number
  readonly newID: string
  readonly newVersion: string
  readonly bindFailure: boolean
}) {
  return {
    event: "service.registration.takeover",
    previousPID: input.previousPID ?? null,
    previousRegistrationID: input.previousID ?? null,
    previousVersion: input.previousVersion ?? null,
    newPID: input.newPID,
    newRegistrationID: input.newID,
    newVersion: input.newVersion,
    bindFailure: input.bindFailure,
  }
}

export function bindFailureFields(meta: ServiceMeta, port: number | undefined) {
  return {
    event: "service.listener.bind-failed",
    pid: meta.pid,
    version: meta.version,
    registrationID: meta.registrationID,
    port: port ?? null,
    bindFailure: true,
  }
}

/** Emitted by the existing uncaught-exception and unhandled-rejection handlers. */
export function errorFields(cause: unknown, origin: "uncaughtException" | "unhandledRejection") {
  const error = cause instanceof Error ? cause : undefined
  return {
    event: "service.process.error",
    origin,
    pid: process.pid,
    message: error?.message ?? "non-Error failure",
    cause: describeCause(error?.cause),
    // Never stringify an arbitrary rejected value: it may contain session content.
    valueType: error === undefined ? typeof cause : null,
  }
}

function uptimeSeconds(state: Lifecycle, now: number) {
  return Math.max(0, Math.floor((now - state.startedAt) / 1000))
}

function describeCause(cause: unknown): string | null {
  if (cause === undefined || cause === null) return null
  if (cause instanceof Error) return cause.message
  return typeof cause === "string" ? cause : null
}

export * as ServiceDiagnostics from "./service-diagnostics"
