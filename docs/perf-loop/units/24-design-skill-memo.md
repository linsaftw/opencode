STATUS: designed
# Skill scan memoization

Add `packages/core/src/config/plugin/skill-cache.ts`. A module-level `Map` is process-global, so no layer/node wiring changes are needed.

```ts
export * as SkillCache from "./skill-cache.js"
import { FSUtil } from "@opencode/util/fs-util"
import path from "path"
import { Effect, Semaphore } from "effect"
import { SkillFile } from "./skill-file.js"
import { SkillScan } from "./skill-scan.js"
type LoadedFile = { readonly filepath: string; readonly resolved: string; readonly result: SkillFile.ParseResult }
type Entry = { readonly directory: string; readonly semaphore: Semaphore.Semaphore; loaded?: readonly LoadedFile[] }
const entries = new Map<string, Entry>()
const loadDirectory = Effect.fn("SkillCache.loadDirectory")(function* (directory: string) {
  const fs = yield* FSUtil.Service
  const loaded: LoadedFile[] = []
  for (const filepath of yield* SkillScan.scan(directory)) {
    const resolved = yield* fs.realPath(filepath).pipe(Effect.orElseSucceed(() => filepath))
    const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
    if (content === undefined) continue
    loaded.push({ filepath, resolved, result: SkillFile.parse(directory, filepath, content) })
  }
  return loaded
})
export const load = Effect.fn("SkillCache.load")(function* (directory: string) {
  const key = path.resolve(directory)
  const entry = entries.get(key) ?? { directory: key, semaphore: Semaphore.makeUnsafe(1) }
  entries.set(key, entry)
  return yield* entry.semaphore.withPermit(
    entry.loaded
      ? Effect.succeed(entry.loaded)
      : loadDirectory(key).pipe(Effect.tap((loaded) => Effect.sync(() => (entry.loaded = loaded)))),
  )
})
export function invalidate(file: string) {
  const target = path.resolve(file)
  for (const [key, entry] of entries) {
    if (FSUtil.overlaps(entry.directory, target) || entry.loaded?.some((item) => FSUtil.overlaps(item.resolved, target)))
      entries.delete(key)
  }
}
```
In `skill.ts` replace the `SkillScan.scan` loop body in `load` with:
```ts
        for (const item of yield* SkillCache.load(directory)) {
          if (!roots.some((root) => FSUtil.contains(root, item.resolved))) yield* watch(item.resolved, "file")
          if (item.result._tag === "Skipped") {
            yield* Effect.logDebug("skill file skipped", {
              filepath: item.filepath,
              reason: item.result.reason,
              ...(item.result.reason === "frontmatter" ? { issue: item.result.issue } : {}),
            })
            continue
          }
          skills.push(item.result.skill)
        }
```
In `compatibility.ts` replace the scan/read/parse loop with:
```ts
          for (const item of yield* SkillCache.load(resolved)) {
            if (item.result._tag === "Parsed") loaded.set(item.result.skill.id, item.result.skill)
          }
```
Drop the now-unused `SkillFile` imports. In both plugins add and use this instead of every `PubSub.publish(changes, ...)`:
```ts
    const notify = (file: string) =>
      Effect.sync(() => SkillCache.invalidate(file)).pipe(
        Effect.andThen(PubSub.publish(changes, file)),
        Effect.asVoid,
      )
```
Concurrency and invalidation:
- Per-key `Semaphore(1)` single-flights: the first Location scans and parses, concurrent Locations wait then read `entry.loaded`; no duplicate walk or `SKILL.md` parse.
- `invalidate` is synchronous and must run in the watcher/config stream before `notify` publishes, so every Location drops the root on its next refresh. `overlaps` handles both child events and ancestor creation (missing roots), and `item.resolved` handles symlinked skill targets.
- If a scan is in flight when a key is deleted, its waiters may get the pre-event snapshot; the same event still triggers a fresh refresh, which creates a new entry and rescans. The old scan writes only to its detached entry.
- No mtime check: content edits do not change directory mtime, so watcher events are the authority.

Tests: `packages/core/test/config/skill.test.ts` rescans/symlink/missing-root/coalescing cases already emit updates and should pass unchanged; `packages/core/test/skill.test.ts` never calls the scan. Add `export function clear()` only if a test mutates a root without an event; otherwise fresh temp roots isolate tests.
