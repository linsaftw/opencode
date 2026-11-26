export * as Wildcard from "./wildcard.js"

// Permission checks match the same few rule patterns against every tool on every step, so compiled patterns are kept.
// Bounded because resource patterns can come from the session. No `g` or `y` flag, so `test` holds no state between calls.
const compiledLimit = 1024
const compiled = new Map<string, RegExp>()

function compile(pattern: string, flags: string) {
  const key = `${flags}\0${pattern}`
  const hit = compiled.get(key)
  if (hit) return hit
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  const created = new RegExp("^" + escaped + "$", flags)
  if (compiled.size >= compiledLimit) compiled.delete(compiled.keys().next().value!)
  compiled.set(key, created)
  return created
}

/** Windows always matches without case; `ignoreCase` extends that to other callers, such as file rules on macOS. */
export function match(input: string, pattern: string, ignoreCase = false) {
  return compile(pattern, process.platform === "win32" || ignoreCase ? "si" : "s").test(input.replaceAll("\\", "/"))
}
