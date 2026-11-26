STATUS: done
Changed: hoisted the per-event `Match.discriminatorsExhaustive` dispatcher to module scope and made handlers curried `(event) => (adapter, created) => Effect`, with helpers (`updateOwnedAssistant`, `clearCurrentRetry`, `idle`) and a shared no-op projection at module scope; `update` now only computes `created` and invokes the matched handler.
Why faster: `Match.add` copies the full cases array on every case, so rebuilding ~50 cases per durable event was quadratic allocation; one matcher is now built once and dispatch is a discriminator lookup, so no-op events also allocate no handler closures.
Risk: purely structural rewrite of the dispatch; effect order, ids, metadata, timestamps and persisted values are unchanged, but declaration-emit type unification of the curried handlers was not compiler-checked here.
Area: message/part accumulation
Files: packages/core/src/session/message-updater.ts
Task: Read the whole file. Make delta/part accumulation O(1) amortized: avoid string += on large text in loops and copying whole part arrays per delta; reuse objects structurally.
