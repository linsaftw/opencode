import { describe, expect } from "bun:test"
import { State } from "@opencode/core/state"
import { Effect, Exit, Scope } from "effect"
import { it } from "./lib/effect"

type Data = { values: string[] }

const base: State.Options<Data, Data> = {
  initial: () => ({ values: [] }),
  editor: (data) => data,
}

const clone = (data: Data): Data => ({ values: [...data.values] })

// Transforms read the draft they are given, so order and prior edits are observable in the result.
const step = (counter: { runs: number }, id: number, fail: boolean) => (data: Data) => {
  counter.runs++
  if (fail && data.values.length === 3) throw new Error(`boom ${id}`)
  data.values.push(`${id}@${data.values.length}`)
}

const create = (incremental: boolean) => {
  const options = incremental ? { ...base, copy: clone } : base
  return State.create<Data, Data>(options)
}

// Mulberry32: small seeded PRNG so every sequence is reproducible.
const random = (seed: number) => {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Entry = { scopes: [Scope.Closeable, Scope.Closeable] }

describe("State incremental rebuild", () => {
  it.effect("appends only the new transforms on a read after each registration", () =>
    Effect.gen(function* () {
      const counter = { runs: 0 }
      const state = create(true)
      const scope = yield* Scope.make()
      for (let id = 0; id < 50; id++) {
        yield* state.transform(step(counter, id, false)).pipe(Scope.provide(scope))
        expect(state.get().values.length).toBe(id + 1)
      }
      expect(counter.runs).toBe(50)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("matches a full replay across seeded random sequences of registrations, disposals, reloads and reads", () =>
    Effect.gen(function* () {
      let incrementalRuns = 0
      let replayRuns = 0
      let reads = 0
      for (let seed = 1; seed <= 300; seed++) {
        const next = random(seed)
        const incCounter = { runs: 0 }
        const refCounter = { runs: 0 }
        const inc = create(true)
        const ref = create(false)
        const entries: Entry[] = []
        const retained: { value: Data; json: string }[] = []
        const failures = { inc: 0, ref: 0 }
        let id = 0

        const register = (grouped: boolean, fail: boolean) =>
          Effect.gen(function* () {
            const current = id++
            const incScope = yield* Scope.make()
            const refScope = yield* Scope.make()
            const incGroup = grouped
              ? State.group(() => {
                  failures.inc++
                })
              : undefined
            const refGroup = grouped
              ? State.group(() => {
                  failures.ref++
                })
              : undefined
            const incRegistration = inc.transform(step(incCounter, current, fail))
            const refRegistration = ref.transform(step(refCounter, current, fail))
            yield* (incGroup ? incGroup(incRegistration) : incRegistration).pipe(Scope.provide(incScope))
            yield* (refGroup ? refGroup(refRegistration) : refRegistration).pipe(Scope.provide(refScope))
            entries.push({ scopes: [incScope, refScope] })
          })

        for (let op = 0; op < 40; op++) {
          const roll = next()
          if (roll < 0.35) yield* register(false, false)
          if (roll >= 0.35 && roll < 0.5) yield* register(true, next() < 0.4)
          if (roll >= 0.5 && roll < 0.6 && entries.length > 0) {
            const [entry] = entries.splice(Math.floor(next() * entries.length), 1)
            if (entry) {
              yield* Scope.close(entry.scopes[0], Exit.void)
              yield* Scope.close(entry.scopes[1], Exit.void)
            }
          }
          if (roll >= 0.6 && roll < 0.65) {
            yield* inc.reload()
            yield* ref.reload()
          }
          if (roll >= 0.65) {
            const value = inc.get()
            expect(value).toEqual(ref.get())
            expect(failures.inc).toBe(failures.ref)
            retained.push({ value, json: JSON.stringify(value) })
            reads++
          }
        }

        expect(inc.get()).toEqual(ref.get())
        for (const kept of retained) expect(JSON.stringify(kept.value)).toBe(kept.json)
        incrementalRuns += incCounter.runs
        replayRuns += refCounter.runs
        for (const entry of entries) {
          yield* Scope.close(entry.scopes[0], Exit.void)
          yield* Scope.close(entry.scopes[1], Exit.void)
        }
      }
      expect(reads).toBeGreaterThan(300)
      expect(incrementalRuns).toBeLessThan(replayRuns)
    }),
  )
})
