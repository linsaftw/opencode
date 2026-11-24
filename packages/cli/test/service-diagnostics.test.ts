import { expect, test } from "bun:test"
import { ServiceDiagnostics } from "../src/service-diagnostics"

const meta = { pid: 2187515, version: "2.4.1", registrationID: "1ff87710", port: 49374 }
const memory = { rss: 10, heapUsed: 2, heapTotal: 4, external: 1, arrayBuffers: 3 } as NodeJS.MemoryUsage

test("started, shutdown and exit fields carry identifiers and coarse reasons only", () => {
  const state = ServiceDiagnostics.begin(meta, 1_000)
  expect(ServiceDiagnostics.startedFields(state)).toEqual({
    event: "service.process.started",
    pid: 2187515,
    version: "2.4.1",
    registrationID: "1ff87710",
    port: 49374,
  })
  ServiceDiagnostics.noteShutdown("signal", "SIGTERM")
  expect(ServiceDiagnostics.shutdownFields(state, 61_000)).toEqual({
    event: "service.process.shutdown",
    pid: 2187515,
    version: "2.4.1",
    registrationID: "1ff87710",
    reason: "signal",
    signal: "SIGTERM",
    uptimeSeconds: 60,
  })
  const exit = ServiceDiagnostics.exitFields(state, 143, 61_000)
  expect(exit.exitCode).toBe(143)
  expect(exit.reason).toBe("signal")
  expect(exit.uptimeSeconds).toBe(60)
  expect(JSON.stringify(exit)).not.toContain("password")
})

test("heartbeat has counts and no session identifiers or content", () => {
  const state = ServiceDiagnostics.begin(meta, 0)
  const fields = ServiceDiagnostics.heartbeatFields(state, "127.0.0.1:49374", memory, 300_000)
  expect(fields).toEqual({
    event: "service.heartbeat",
    pid: 2187515,
    version: "2.4.1",
    registrationID: "1ff87710",
    port: 49374,
    address: "127.0.0.1:49374",
    uptimeSeconds: 300,
    rssBytes: 10,
    heapUsedBytes: 2,
    heapTotalBytes: 4,
    externalBytes: 1,
    arrayBuffersBytes: 3,
    fdCount: null,
    fdBreakdown: null,
    fdPreviousCount: null,
    fdGrowth: null,
  })
  expect(ServiceDiagnostics.HEARTBEAT_INTERVAL).toBe("5 minutes")
})

test("FD targets become coarse counts that never expose paths", () => {
  const breakdown = ServiceDiagnostics.categorizeFdTargets([
    "/home/alice/.context-mode/projects/secret-hash/context.db",
    "/home/alice/.context-mode/projects/secret-hash/context.db-wal",
    "/home/alice/.context-mode/projects/secret-hash/context.db-wal (deleted)",
    "/home/alice/.context-mode/projects/secret-hash/context.db-shm",
    "anon_inode:inotify",
    "anon_inode:[pidfd]",
    "socket:[12345]",
    "pipe:[6789]",
    "/dev/null",
  ])
  expect(breakdown).toEqual({
    total: 9,
    contextDb: 1,
    contextDbWal: 2,
    contextDbShm: 1,
    inotify: 1,
    pidfd: 1,
    sockets: 1,
    pipes: 1,
    other: 1,
  })
  expect(JSON.stringify(breakdown)).not.toContain("alice")
  expect(JSON.stringify(breakdown)).not.toContain("secret-hash")
  expect(ServiceDiagnostics.categorizeFdTargets([]).total).toBe(0)
})

test("stall gap detection triggers only beyond twice the configured interval", () => {
  expect(ServiceDiagnostics.HEARTBEAT_INTERVAL_MS).toBe(300_000)
  expect(ServiceDiagnostics.STALL_THRESHOLD_MS).toBe(600_000)
  expect(ServiceDiagnostics.stallGapMs(1_000, 601_000)).toBe(600_000)
  expect(ServiceDiagnostics.stallGapMs(601_000, 1_000)).toBe(0)
  expect(ServiceDiagnostics.isStalledGap(600_000)).toBe(false)
  expect(ServiceDiagnostics.isStalledGap(600_001)).toBe(true)
  expect(ServiceDiagnostics.isStalledGap(900_000, 1_000_000)).toBe(false)
})

test("heartbeat reports FD growth and stall warning stays privacy-safe", () => {
  const state = ServiceDiagnostics.begin(meta, 0)
  const fd = ServiceDiagnostics.categorizeFdTargets(["socket:[1]", "context.db"])
  const fields = ServiceDiagnostics.heartbeatFields(state, "127.0.0.1:49374", memory, 300_000, fd, 1)
  expect(fields.fdCount).toBe(2)
  expect(fields.fdPreviousCount).toBe(1)
  expect(fields.fdGrowth).toBe(1)
  expect(fields.fdBreakdown).toEqual(fd)
  const warning = ServiceDiagnostics.stallWarningFields(state, memory, fd, 900_000, 300_000)
  expect(warning).toMatchObject({
    event: "service event loop stalled",
    pid: 2187515,
    registrationID: "1ff87710",
    gapMs: 900_000,
    thresholdMs: 600_000,
    rssBytes: 10,
    fdCount: 2,
    fdBreakdown: fd,
  })
  expect(JSON.stringify(warning)).not.toContain("context.db")
  expect(JSON.stringify(warning)).not.toContain("password")
})

test("registration takeover records previous and new PID with bind outcome", () => {
  expect(
    ServiceDiagnostics.registrationFields({
      previousPID: 2076117,
      previousID: "6659e68a",
      previousVersion: "2.4.0",
      newPID: 2187515,
      newID: "1ff87710",
      newVersion: "2.4.1",
      bindFailure: false,
    }),
  ).toEqual({
    event: "service.registration.takeover",
    previousPID: 2076117,
    previousRegistrationID: "6659e68a",
    previousVersion: "2.4.0",
    newPID: 2187515,
    newRegistrationID: "1ff87710",
    newVersion: "2.4.1",
    bindFailure: false,
  })
  expect(ServiceDiagnostics.bindFailureFields(meta, 49374)).toEqual({
    event: "service.listener.bind-failed",
    pid: 2187515,
    version: "2.4.1",
    registrationID: "1ff87710",
    port: 49374,
    bindFailure: true,
  })
})

test("error fields use messages only and never stringify a rejected value", () => {
  const error = new Error("socket closed", { cause: new Error("ECONNRESET") })
  expect(ServiceDiagnostics.errorFields(error, "uncaughtException")).toMatchObject({
    event: "service.process.error",
    origin: "uncaughtException",
    message: "socket closed",
    cause: "ECONNRESET",
  })
  const rejected = ServiceDiagnostics.errorFields({ sessionID: "secret-content" }, "unhandledRejection")
  expect(rejected.message).toBe("non-Error failure")
  expect(rejected.valueType).toBe("object")
  expect(JSON.stringify(rejected)).not.toContain("secret-content")
})

test("error hooks mark the active service process without inventing a signal", () => {
  const state = ServiceDiagnostics.begin(meta, 0)
  ServiceDiagnostics.noteError("unhandled-rejection")
  expect(ServiceDiagnostics.currentShutdownFields(1_000)?.reason).toBe("unhandled-rejection")
  expect(ServiceDiagnostics.shutdownFields(state, 1_000).signal).toBeNull()
})
