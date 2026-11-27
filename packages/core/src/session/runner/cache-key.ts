import { createHash } from "node:crypto"

/** Primary and compaction requests share the session's prompt-cache prefix; one-off side requests must not evict it. */
export const promptCacheKey = (affinity: string, kind: string): string => {
  const base = /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity
  return kind === "primary" || kind === "compaction"
    ? base
    : createHash("sha256").update(base).update("\0").update(kind).digest("hex")
}
