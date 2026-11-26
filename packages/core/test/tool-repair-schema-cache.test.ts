import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { repairInputSchema } from "@opencode/core/tool/runtime"

const tool = (input: Schema.Top) => ({
  id: "cached",
  name: "cached",
  description: "Schema cache",
  input,
  execute: () => Effect.succeed({ content: "unused" }),
})

describe("repairInputSchema", () => {
  test("reuses the conversion for the same schema object", () => {
    const schema = Schema.Struct({ path: Schema.String })
    expect(repairInputSchema(tool(schema))).toBe(repairInputSchema(tool(schema)))
  })

  test("converts again when a tool is replaced with a different schema", () => {
    const first = repairInputSchema(tool(Schema.Struct({ path: Schema.String })))
    const second = repairInputSchema(tool(Schema.Struct({ path: Schema.String, limit: Schema.Number })))
    expect(second).not.toBe(first)
    expect(JSON.stringify(second)).toContain("limit")
    expect(JSON.stringify(first)).not.toContain("limit")
  })

  test("matches an uncached definition", () => {
    const schema = Schema.Struct({ path: Schema.String, line: Schema.optional(Schema.Int) })
    expect(repairInputSchema(tool(schema))).toEqual(repairInputSchema(tool(schema)))
  })
})
