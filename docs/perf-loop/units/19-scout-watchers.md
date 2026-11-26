STATUS: scouted

# Watchers and Location boot

## 1. Where watchers are created and whether they are shared
- Central service: `packages/core/src/filesystem/watcher.ts`. `subscribe()` resolves the target with `path.resolve` and logs "watcher subscribe" (127-135). The actual native watch is created in a process-global `RcMap` lookup (91-125); "watcher started" (117-122) fires once per new key.
- Key is structural `{ type, target, ignore, names }` (138). Identical lexical paths are deduplicated and shared across Locations because the service is a global node (`watcher.ts:240-244`, `configured()`), and RcMap refcounts subscribers. Each Location still calls subscribe and holds its own ref.
- No canonicalization beyond `path.resolve`: symlinked or case-variant paths become distinct keys and separate native watches.
- `nativeLayer` (202-236): `file` and `entries` watches use one `node:fs.watch` on the parent directory per target (206-215); `directory` watches use `@parcel/watcher` (233). Several files in one directory therefore create several redundant `fs.watch` handles.
- Per-Location creators: instruction plugin `packages/core/src/config/plugin/instruction.ts:63-66` (one `file` watch per ancestor AGENTS.md/CLAUDE.md) and `:144-149` (configured instructions); skill plugin `skill.ts:37-48`; compatibility plugin `compatibility.ts:26-39`; plugin source `source.ts:51-73`; config `config.ts:417-442`; repository `location-watcher.ts:55-78`.
- Repeated subscribe without a new native watch happens because `watcher.subscribe(...)` is evaluated before `FiberMap.run(..., { onlyIfMissing: true })` at `instruction.ts:144-149` and `config.ts:428-441`.

## 2. Heavy work while "location services booted" is logged
- The log is emitted only after the whole Location graph builds (`instance.ts:64-122`, `:127-189`). All layer construction before that point is on the boot path.
- Config discovery and initial load run synchronously in the graph: `config.ts:410-411`, `ConfigDiscovery.discover` walks ancestors and lists every candidate directory (`config/discovery.ts:70-179`), then every config layer is read, parsed and normalized before boot completes.
- Plugin activation is forked (`plugin/supervisor.ts:260-272`), but it starts immediately and runs the post built-ins (`plugin/internal.ts:314-335`). Their initial refreshes are the heavy part:
  - Instruction: `instruction.ts:230-231` calls `reconfigure`/`refresh`; `projectSource` walks upward with `fs.up` (`:94`) and reads every found file (`:97`); configured globs are matched and read (`:126-152`).
  - Skill: `skill.ts:149-167` clears all watch fibers (`:151`), then for every source scans the tree (`:120-139`) and reads/parses each skill file (`:123-128`). `SkillScan.scan` is a sequential depth-first walk (`config/plugin/skill-scan.ts:11-45`).
  - Compatibility: `compatibility.ts:41-61` repeats the same clear/scan/read for `~/.claude/skills` and `~/.agents/skills` in every Location.
- MCP is not a boot blocker: initial connections are explicitly forked so one slow server does not block Location startup (`mcp/index.ts:913-927`).
- `LocationWatcher` is ordered last and awaits plugin activation (`instance.ts:120-121`, `filesystem/location-watcher.ts:90-92`), so repository watches start after the boot-critical work.

## 3. Highest-impact fixes
1. Stop rebuilding all skill watchers on every refresh: `config/plugin/skill.ts:151` and `config/plugin/compatibility.ts:43` call `FiberMap.clear(watches)`. Remove the clear; compute the current watch-key set and `FiberMap.remove` only keys that disappeared, relying on `onlyIfMissing` for the rest. Behavior is unchanged, but refreshes stop closing and reopening the same native watches (the stop/start churn behind repeated "watcher started").
2. Batch instruction file watches per directory: replace the per-file loop at `config/plugin/instruction.ts:63-66` with a group by `path.dirname(file)` and one `{ path: directory, type: "entries", names }` watch per directory. Same events, far fewer native handles because `nativeLayer` otherwise starts a separate `fs.watch` per file in that directory (`filesystem/watcher.ts:202-215`). Also move the `watcher.subscribe` at `instruction.ts:144-149`, and at `config.ts:428`, inside the `FiberMap.run` effect so an existing key is not re-subscribed on every refresh.
3. Scan shared global skill roots once per process: `skill.ts:120-139` and `compatibility.ts:45-57` rescan and reparse the same global `~/.claude/skills` / `~/.agents/skills` trees for every Location at boot. Memoize `SkillScan.scan` + parse results in a global cache keyed by resolved directory and directory mtime (`config/plugin/skill-scan.ts:11`), invalidated by the existing watch updates. Same skill set, but 36 boots no longer multiply the same filesystem walk and SKILL.md parsing.
