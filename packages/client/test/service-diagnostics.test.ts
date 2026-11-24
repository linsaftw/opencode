import { expect, test } from "bun:test"
import { terminationFields } from "../src/service-diagnostics"

const info = { id: "reg-123", version: "2.4.1", pid: 4242 }

test("termination fields identify target, caller, signal and cause without secrets", () => {
  const fields = terminationFields({ ...info, url: "http://u:p@127.0.0.1:49374" }, { cause: "explicit-stop" }, "SIGTERM", 77)
  expect(fields).toEqual({
    event: "service.terminate",
    signal: "SIGTERM",
    targetPID: 4242,
    registrationID: "reg-123",
    serviceVersion: "2.4.1",
    callerPID: 77,
    cause: "explicit-stop",
  })
  const text = JSON.stringify(fields)
  expect(text).not.toContain("password")
  expect(text).not.toContain("url")
  expect(text).not.toContain("u:p@")
})

test("unresponsive termination records streak, window and restart token", () => {
  const fields = terminationFields(
    info,
    { cause: "unresponsive", streak: 12, windowMs: 125_000, restartToken: "lock-token" },
    "SIGKILL",
    1,
  )
  expect(fields.signal).toBe("SIGKILL")
  expect(fields.streak).toBe(12)
  expect(fields.windowMs).toBe(125_000)
  expect(fields.restartToken).toBe("lock-token")
})

test("version replacement records the previous version; missing ids are safe", () => {
  expect(
    terminationFields(
      { pid: 99 },
      { cause: "version-mismatch", previousVersion: "2.4.0", restartToken: "t" },
      "SIGTERM",
      2,
    ),
  ).toMatchObject({
    targetPID: 99,
    registrationID: "unknown",
    serviceVersion: "unknown",
    cause: "version-mismatch",
    previousVersion: "2.4.0",
    restartToken: "t",
  })
})
