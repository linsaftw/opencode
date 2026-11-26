STATUS: done
Area: request building and prefix stability
Files: packages/core/src/session/model-request.ts
Task: Read the whole file. Remove repeated work building the provider request per step, memoize pure derived values per message identity, keep ordering and serialization deterministic so the serialized prefix stays byte-identical between steps.
Changed: memoized per-message `toLLMMessages` conversion, tool-schema JSON serialization and per-message image sizes in WeakMaps keyed by object identity; skipped the unsupported-media walk when the model accepts every modality and is not xAI.
Faster: each step now reuses base64 attachment decoding, tool-schema stringify and media scanning instead of redoing them over the full history, while order and serialization are unchanged.
Risk: caches assume stored messages, registered tool definitions and converted LLM messages are immutable; an in-place mutation by a plugin hook or downstream consumer could leak into a later step.

