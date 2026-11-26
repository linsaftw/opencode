STATUS: scouted (nothing applied; see LOG)
# Unit 31 (scout, read-only on source): service/Location cold-start cost
Read packages/core/src/instance.ts (Location boot), config/plugin/*.ts, plugin/supervisor.ts, mcp/index.ts startup, filesystem/location-watcher.ts, skill/instruction discovery. Find work done at every Location boot that is repeated per Location but identical across Locations (global config reads, global skill dir scans, provider discovery), synchronous work that blocks the boot path but could run after readiness without changing observable results, and N+1 filesystem calls. Skip: skill-scan memo (unit 24, deferred). For each: file:line, cost scenario, minimal safe fix, risk. Top 5 ranked under "## Findings". Edit no other file; before finishing, re-read this file to confirm the Findings are on disk.

## Findings

Ranked by expected cold-start win versus safety. Paths are relative to the repository root. No source was edited.

### 1. Well-known integration configs are re-fetched over HTTP for every Location

- `packages/core/src/config.ts:194` calls `wellknown.resolve(entry, variables)` while the Config layer is still being built (`config.ts:410-411`), so a Location cannot finish booting until it returns.
- `packages/core/src/wellknown.ts:215-220` (`resolve`) always runs `resolveEntry` (an HTTP GET of the integration's config document) and then writes the KV cache. The in-memory map only caches manifests (`wellknown.ts:113-160`); resolved documents are served from `cached()` only on error (`config.ts:195-201`).
- Cost scenario: with one to three well-known integrations (Console, etc.) on a 100-300 ms link, every new Location pays one to three serialized round trips plus KV writes before it is usable. Opening N projects on a cold server performs N times M requests.
- Minimal safe fix: memoize resolved documents in the existing global `WellKnown` node keyed by `origin` plus a credential fingerprint, using the same single-flight/TTL shape as `SharedCache` (`shared-cache.ts:53-100`), and keep the current "last good config on error" fallback. Invalidate on `Credential.Event.Switched`, `WellKnown.Event.Updated`, and the existing 10-minute refresh (`config.ts:483-505`).
- Risk: remote provider/policy documents stay stale until the TTL or an event. If integration policies must be fresh at boot, cache only the non-policy documents or lower the TTL. Tests that assert `fetch` call counts need updating.

### 2. Global/system config is discovered, read and parsed for every Location (including a `plutil` subprocess on macOS)

- `packages/core/src/config/discovery.ts:83-87`, `discovery.ts:127-131` and `discovery.ts:150` re-realpath the system and global config roots, the system/global config files and `isDir` the system directory on every Location.
- `packages/core/src/config.ts:322-324` loads the system config directory and `config.ts:347-349` loads the global config directory; both re-read and re-parse `opencode.json`/`opencode.jsonc` for every Location.
- `packages/core/src/config.ts:256-277` runs `plutil -convert json` as a child process per Location on macOS whenever managed preferences are present (`config.ts:324`).
- Cost scenario: about 8-10 extra syscalls plus 2-6 file reads/JSONC parses per Location, and a process spawn (roughly 10-40 ms) on managed macOS machines. All of it is identical for every Location in the process.
- Minimal safe fix: cache the system/global `Document[]` and the converted plist in a process-global node keyed by resolved path plus mtime/size, and invalidate from the existing per-Location config watchers so edits still reload. Project and explicit sources stay per Location.
- Risk: mtime granularity and atomic-save renames can miss a same-second edit; drive invalidation from the config watcher event rather than only mtime. Variable substitution depends on process env, which is shared, so cache substituted text per path. Cache hits must not change the load order in `config.ts:379-392`.

### 3. Global config directories are glob-scanned per Location for agents, commands and plugins

- `packages/core/src/config/plugin/agent.ts:44-45,54` runs `discover` (`agent.ts:135-139`, two globs) over every `Directory` config entry on each activation. The global config dir, `~/.claude` and `~/.agents` entries are identical for every Location.
- `packages/core/src/config/plugin/command.ts:30-31,41` with `command.ts:121-130` repeats the same for `{command,commands}/**/*.md`.
- `packages/core/src/config/plugin/source.ts:125-136` with `packages/core/src/plugin/source-directory.ts:9-32` re-lists `<dir>/{plugin,plugins}` and resolves every child on each activation, global dirs included.
- The skill directory scans (`config/plugin/skill.ts:139`, `config/plugin/compatibility.ts:63`) have the same shape but belong to unit 24's deferred skill-scan memo, so no separate fix is proposed here.
- Cost scenario: three glob traversals, two directory listings and per-file reads/parses per Location. With a populated global config (say 20 agents, 30 commands, several plugins) that repeats dozens of file reads at every Location, inside plugin activation, so the first prompt for a new Location waits for it.
- Minimal safe fix: share the scan result in a process-global cache keyed by `(realpath(directory), mtimeMs)` for the legacy agent globs, the command glob and the plugin listings; cache parsed documents/names and invalidate from the existing `config.changes()` feed (`config/plugin/entry-observer.ts:53-59`), which already watches these directories.
- Risk: a directory mtime does not change when a nested file's contents change. Key on the discovered files' mtimes or invalidate from watcher events. A missed event leaves the cached agents/commands until restart, matching the current watch-based reload behaviour.

### 4. Provider plugins re-read global credential files per Location

- `packages/core/src/plugin/provider/amazon-bedrock.ts:27-34` reads `~/.aws/config` and `~/.aws/credentials` during every Location's activation.
- `packages/core/src/plugin/provider/google-vertex.ts:60-76` reads the gcloud `active_config`, lists `configurations`, reads every config file plus `application_default_credentials.json` per Location (an N+1 read after the listing).
- `packages/core/src/plugin/provider/azure.ts:86-91` defines the `az` CLI helper; when Azure is configured, activation forks discovery (`azure.ts:354,427`), which shells out to `az account get-access-token` and further `az` calls, one CLI process per Location.
- Cost scenario: 2-10 small file reads per Location for AWS/GCP users; 100 ms and up of `az` startup per Location for Azure users. The results depend only on process env and home, so they are identical across Locations.
- Minimal safe fix: a module-level memo like the `discovery` map already used at `plugin/provider/local.ts:48`, keyed by file path plus mtime, storing parsed profile/project lists with a short TTL. For Azure, move the per-plugin `tokens` map (`azure.ts:75`) to a process-global cache so each Location does not spawn `az` for the same token.
- Risk: stale profiles or tokens after a user edits `~/.aws`/gcloud files or rotates credentials without restarting; an mtime check or short TTL bounds it. Cross-Location token reuse already exists in spirit because tokens are cached per plugin.

### 5. N+1 ancestor existence walk during config discovery

- `packages/core/src/config/discovery.ts:88-92` calls `fs.up({ targets: ["."], start: location.directory })`. `packages/util/src/fs-util.ts:148-172` loops to the filesystem root, running one `fs.exists(join(current, "."))` per ancestor per target. Every ancestor of an already resolved directory provably exists, so these stats are redundant; they only build the ancestor list.
- Cost scenario: one extra syscall per path component per Location (6-10 for a repo under a deep home directory, more on Windows). The same `up` walk is used in `config/plugin/instruction.ts:94` with two target names per ancestor (2 stats times depth); that probe is legitimate, but it can reuse one directory listing per level as `discovery.ts:100-105` already does.
- Minimal safe fix: replace the `targets: ["."]` walk with path arithmetic (`path.dirname` until the root, the same loop as `config/plugin/instruction.ts:259-262`), keeping the `fs.resolve` of the location. Behaviour is unchanged because the list is only fed into `path.join(directory, name)` afterwards.
- Risk: sandboxes that deny `stat` on an ancestor currently drop that ancestor from the list; arithmetic would include it, and `discover` would then fall back to six per-candidate probes for it (more syscalls, same result). Mitigate by stopping the walk at the first ancestor whose `readDirectory` fails.

## Observed but not chosen

- MCP: each Location connects to its own configured servers unless `pool: true` (`packages/core/src/mcp/index.ts:643-646`), including identical remote servers. Connections are forked after boot (`mcp/index.ts:922-935`) so they do not block Location readiness, but they consume network and process slots. Sharing is exactly what `McpPool` exists for; changing the default changes connection/roots semantics, so it needs a separate decision.
- Instructions: the global `AGENTS.md`/`~/.claude/CLAUDE.md` contents are read once per Location at activation (`config/plugin/instruction.ts:41-45,82-90`). The watcher is a global node and dedupes equivalent targets (`filesystem/watcher.ts:96-110`), so only the read and parse repeat. Small on its own; a good candidate for the same global document cache as finding 2.
- Plugin activation and the Location watcher are already forked (`plugin/supervisor.ts:260-272`, `filesystem/location-watcher.ts:90-99`), so they do not block `Instance.layer` from returning. The per-Location costs above sit on the path to the first prompt instead.
