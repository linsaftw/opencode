import { expect, test } from "bun:test"
import { decide, type LocalService } from "../src/service-probe"
import { defaultEnsureTiming, unresponsiveVerdict, type Unresponsive } from "../src/service-timing"

const protocolError =
  "Background service uses an incompatible health protocol. Update this client or explicitly restart the service."

function service(input: Pick<LocalService, "state" | "compatible" | "version">) {
  return {
    info: { url: "http://127.0.0.1:4096", pid: 4242, version: input.version },
    endpoint: { url: "http://127.0.0.1:4096" },
    ...input,
  } satisfies LocalService
}

test("a missing health endpoint fails unless the caller requires a different version", () => {
  const missing = service({ version: "2.0.0", state: "ready", compatible: false })
  expect(decide(missing, {})).toEqual({ _tag: "fail", error: new Error(protocolError) })
  expect(decide(missing, { version: "2.0.0" })).toEqual({ _tag: "fail", error: new Error(protocolError) })
  expect(decide(missing, { version: (version) => version.startsWith("2.") })).toEqual({
    _tag: "fail",
    error: new Error(protocolError),
  })
  expect(decide(missing, { version: "3.0.0" })).toEqual({ _tag: "replace", pty: "handoff" })
  expect(decide(service({ state: "ready", compatible: false }), { version: "3.0.0" })).toEqual({
    _tag: "replace",
    pty: "handoff",
  })
})

test("a compatible service is reused when ready, awaited while starting, and fails when it failed", () => {
  expect(decide(service({ version: "2.0.0", state: "ready", compatible: true }), {})).toEqual({ _tag: "reuse" })
  expect(decide(service({ version: "2.0.0", state: "waiting", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "wait",
  })
  expect(decide(service({ version: "2.0.0", state: "failed", compatible: true }), {})).toEqual({
    _tag: "fail",
    error: new Error("Background service failed to start"),
  })
})

test("a version mismatch replaces the service, handing off terminals only when it is ready", () => {
  expect(decide(service({ version: "1.0.0", state: "ready", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "handoff",
  })
  expect(decide(service({ version: "1.0.0", state: "waiting", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "clear",
  })
  expect(decide(service({ version: "1.0.0", state: "failed", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "clear",
  })
})

// Simulates probes that each time out after requestTimeout, as ensure() sees them, on a fake clock.
function timeline(cpu: (tick: number) => number | undefined, seconds: number) {
  const terminations: number[] = []
  let prior: Unresponsive | undefined
  for (let at = 10_000; at <= seconds * 1000; at += defaultEnsureTiming.requestTimeout) {
    const verdict = unresponsiveVerdict(prior, at, cpu(at), defaultEnsureTiming)
    if (verdict.terminate) {
      terminations.push(at)
      prior = undefined
      continue
    }
    prior = { since: verdict.since, cpu: verdict.cpu }
  }
  return terminations
}

test("a slow but alive owner whose CPU keeps advancing is never terminated", () => {
  expect(timeline((at) => at, 600)).toEqual([])
})

test("a hung owner with no CPU progress is terminated once, after 60 s of wall-clock timeouts", () => {
  expect(timeline(() => 1_000, 130)).toEqual([70_000])
})

test("without /proc the wall-clock rule alone terminates a silent owner", () => {
  expect(timeline(() => undefined, 80)).toEqual([70_000])
})

test("a version mismatch still replaces without waiting for the unresponsive grace", () => {
  expect(decide(service({ version: "1.0.0", state: "ready", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "handoff",
  })
})
