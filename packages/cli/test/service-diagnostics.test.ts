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
  })
  expect(ServiceDiagnostics.HEARTBEAT_INTERVAL).toBe("5 minutes")
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
