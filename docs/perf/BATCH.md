# Batch cadence (user order 2026-11-27)
- Work phase: many native coders in parallel on disjoint files; each edits src + writes its probe and runs ONLY its own
  probe file (bun test <file>); no bun typecheck, no full suites, no builds by coders. Coders never commit.
- Build phase every 30-60 min: wait for ALL agents to stop, launch NO new agents; then bun typecheck (core, server, cli),
  the full probe list, fix stacked errors in one round (revert what cannot be proven), commit, push, build, install.
  When the build finishes, resume the work phase.
- Service swap needs the user's go-ahead (old pid must exit once).
- Wave 1 work phase started 15:28.
