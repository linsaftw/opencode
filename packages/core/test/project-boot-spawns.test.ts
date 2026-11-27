import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { initGit } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Probe: git spawns made by one fresh Project.Service boot (a new layer, so a new per-layer cache) that resolves
// a directory. Each case boots twice to show repeat boots of the same directory in one process. Argv and results
// go to PROJECT_BOOT_PROBE_OUT when set, with temp paths replaced, so before/after runs can be diffed.
const remote = "git@github.com:owner/repo.git"
const date = "2026-01-01T00:00:00Z"

describe("Project boot git spawns", () => {
  testEffect(Layer.empty).live("counts and records git spawns per fresh boot", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const main = path.join(tmp.path, "repo")
          const linked = path.join(tmp.path, "linked")
          const plain = path.join(tmp.path, "plain")
          const bare = path.join(tmp.path, "norepo")
          yield* Effect.promise(async () => {
            await fs.mkdir(main)
            await initGit(main)
            await $`git commit --allow-empty -m root`.cwd(main).env(commitEnv).quiet()
            await $`git remote add origin ${remote}`.cwd(main).quiet()
            await $`git worktree add ${linked} -b linked`.cwd(main).quiet()
            await fs.mkdir(plain)
            await initGit(plain)
            await $`git commit --allow-empty -m root`.cwd(plain).env(commitEnv).quiet()
            await fs.mkdir(bare)
          })
          const cases = [
            { name: "remote", directory: main },
            { name: "no-remote", directory: plain },
            { name: "worktree", directory: linked },
            { name: "non-git", directory: bare },
          ]
          const report: Record<string, unknown> = {}
          for (const item of cases) {
            const boots = []
            for (const _ of [1, 2]) {
              const argv: string[][] = []
              const result = yield* boot(item.directory, argv)
              boots.push({ spawns: argv.length, argv: argv.map((args) => args.slice(1)), result })
            }
            expect(boots[1].result).toEqual(boots[0].result)
            report[item.name] = boots
          }
          const text = JSON.stringify(report, null, 2).split(tmp.path).join("<TMP>")
          console.log(text)
          const out = process.env.PROJECT_BOOT_PROBE_OUT
          if (out) yield* Effect.promise(() => fs.writeFile(out, text + "\n"))
          expect(Object.keys(report)).toEqual(cases.map((item) => item.name))
        }),
      (tmp) => Effect.promise(() => fs.rm(tmp.path, { recursive: true, force: true })),
    ),
    { timeout: 120_000 },
  )
})

const commitEnv = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }

function boot(directory: string, argv: string[][]) {
  return Effect.gen(function* () {
    const project = yield* Project.Service
    return yield* project.resolve(AbsolutePath.make(directory))
  }).pipe(
    Effect.provide(AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node]), [recorder(argv)])),
    Effect.map((resolved) => JSON.parse(JSON.stringify(resolved))),
  )
}

// Records every spawned command as [executable, ...args], then runs it unchanged.
function recorder(argv: string[][]) {
  return CrossSpawnSpawner.node.replace(
    CrossSpawnSpawner.node.mapLayer((base) =>
      Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
          ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand") argv.push([command.command, ...command.args.map(String)])
            return spawner.spawn(command)
          }),
        ),
      ).pipe(Layer.provide(base)),
    ),
  )
}
