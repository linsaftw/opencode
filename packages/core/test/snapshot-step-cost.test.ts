import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { ID } from "@opencode/schema/snapshot"
import { Snapshot } from "@opencode/core/snapshot"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Each probe compares a warm store (reused across the start and end captures of a step) with a cold store
// (fresh data directory, so no cached state from earlier captures). The cold result is the unoptimized path.
describe("Snapshot step cost probes", () => {
  scenario("no-op step", async () => {}, [])

  scenario(
    "file edited by a tool during the step",
    async (dir) => {
      await fs.writeFile(path.join(dir, "tracked.txt"), "two\n")
    },
    ["tracked.txt"],
  )

  scenario(
    "file edited externally mid-step",
    async (dir) => {
      await fs.writeFile(path.join(dir, "tracked.txt"), "external\n")
      await fs.writeFile(path.join(dir, "other.txt"), "external\n")
    },
    ["other.txt", "tracked.txt"],
  )

  scenario(
    "new untracked file",
    async (dir) => {
      await fs.writeFile(path.join(dir, "fresh.txt"), "new\n")
    },
    ["fresh.txt"],
  )

  testEffect(Layer.empty).live("counts git invocations for a no-op step and a single edit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(() => setup(project))
          const trace = path.join(tmp.path, "git-trace.log")
          const previous = process.env.GIT_TRACE
          process.env.GIT_TRACE = trace
          try {
            yield* capture(path.join(tmp.path, "warm"), project)
            yield* Effect.promise(() => fs.rm(trace, { force: true }))
            yield* capture(path.join(tmp.path, "warm"), project)
            yield* capture(path.join(tmp.path, "warm"), project)
            const noop = yield* Effect.promise(() => countGit(trace))
            yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.txt"), "edit\n"))
            yield* Effect.promise(() => fs.rm(trace, { force: true }))
            yield* capture(path.join(tmp.path, "warm"), project)
            yield* capture(path.join(tmp.path, "warm"), project)
            const edit = yield* Effect.promise(() => countGit(trace))
            // Measured baseline; a rise means a new git process per capture was added.
            console.log(`git invocations: no-op step=${noop} edit step=${edit}`)
            expect(noop).toBeLessThanOrEqual(GIT_NOOP_STEP_MAX)
            expect(edit).toBeLessThanOrEqual(GIT_EDIT_STEP_MAX)
          } finally {
            if (previous === undefined) delete process.env.GIT_TRACE
            else process.env.GIT_TRACE = previous
          }
        }),
      (tmp) => Effect.promise(() => fs.rm(tmp.path, { recursive: true, force: true })),
    ),
    { timeout: 60_000 },
  )
})

// Measured on the current implementation: a no-op step (two captures) and a step with one edit.
const GIT_NOOP_STEP_MAX = 14
const GIT_EDIT_STEP_MAX = 16

// Regression: a same-size edit within the same second as the previous stat record. Before the seed-copy fix, the
// cold store (seeded from the project index) missed the edit about 1 in 8 runs. Each iteration uses a fresh repo.
describe("Snapshot same-second edits", () => {
  testEffect(Layer.empty).live("a same-size edit right after a capture is never lost", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          let stale = 0
          let diverged = 0
          for (let i = 0; i < 60; i++) {
            const project = path.join(tmp.path, `project-${i}`)
            yield* Effect.promise(() => setup(project))
            const start = yield* capture(path.join(tmp.path, `warm-${i}`), project)
            yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.txt"), "two\n"))
            const end = yield* capture(path.join(tmp.path, `warm-${i}`), project)
            const coldEnd = yield* capture(path.join(tmp.path, `cold-${i}`), project)
            if (end === start) stale++
            if (end !== coldEnd) diverged++
          }
          expect({ stale, diverged }).toEqual({ stale: 0, diverged: 0 })
        }),
      (tmp) => Effect.promise(() => fs.rm(tmp.path, { recursive: true, force: true })),
    ),
    { timeout: 120_000 },
  )
})

function scenario(name: string, mutate: (dir: string) => Promise<void>, changed: string[]) {
  testEffect(Layer.empty).live(name, () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(() => setup(project))
          const warm = path.join(tmp.path, "warm")

          const start = yield* capture(warm, project)
          const coldStart = yield* capture(path.join(tmp.path, "cold-start"), project)
          expect(start).toBe(coldStart)

          yield* Effect.promise(() => mutate(project))

          const end = yield* capture(warm, project)
          const coldEnd = yield* capture(path.join(tmp.path, "cold-end"), project)
          expect(end).toBe(coldEnd)

          const files = yield* listFiles(warm, project, start, end)
          expect(files).toEqual(yield* listFiles(path.join(tmp.path, "cold-end"), project, coldStart, coldEnd))
          expect(files).toEqual(changed.map((file) => RelativePath.make(file)))

          const diff = yield* diffs(warm, project, start, end)
          expect(diff).toEqual(yield* diffs(path.join(tmp.path, "cold-end"), project, coldStart, coldEnd))
        }),
      (tmp) => Effect.promise(() => fs.rm(tmp.path, { recursive: true, force: true })),
    ),
    { timeout: 60_000 },
  )
}

function layer(data: string, directory: string) {
  return AppNodeBuilder.build(Snapshot.node, [
    Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
    Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
  ])
}

function capture(data: string, directory: string) {
  return Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    return yield* snapshot.capture()
  }).pipe(Effect.provide(layer(data, directory)), Effect.map((tree) => String(tree)))
}

function listFiles(data: string, directory: string, from: string, to: string) {
  return Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    return yield* snapshot.files({ from: ID.make(from), to: ID.make(to) })
  }).pipe(Effect.provide(layer(data, directory)), Effect.orDie, Effect.map((files) => [...files].sort()))
}

function diffs(data: string, directory: string, from: string, to: string) {
  return Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    return yield* snapshot.diff({ from: ID.make(from), to: ID.make(to), context: 0 })
  }).pipe(Effect.provide(layer(data, directory)), Effect.orDie)
}

async function setup(directory: string) {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "tracked.txt"), "one\n")
  await $`git init`.cwd(directory).quiet()
  await $`git -c user.email=test@opencode.test -c user.name=Test add .`.cwd(directory).quiet()
  await $`git -c user.email=test@opencode.test -c user.name=Test commit --no-gpg-sign -m initial`
    .cwd(directory)
    .quiet()
}

async function countGit(trace: string) {
  const text = await fs.readFile(trace, "utf8").catch(() => "")
  return text.split("\n").filter((line) => /\bgit\b/.test(line) && /trace: (built-in|exec|start_command)/.test(line))
    .length
}
