import { describe, expect, test } from "bun:test"
import { Message } from "@opencode/ai"
import { dedupe } from "../src/session/runner/dedupe-tool-results"

const big = "x".repeat(2048) + "A"
const other = "x".repeat(2048) + "B"

const tool = (id: string, name: string, value: string) =>
  new Message({
    role: "tool",
    content: [{ type: "tool-result", id, name, result: { type: "text", value } }],
  })

const valueOf = (message: Message) => {
  const part = message.content[0]!
  if (part.type !== "tool-result") throw new Error("expected tool-result")
  return part.result.type === "text" ? part.result.value : undefined
}

describe("dedupe tool results", () => {
  test("keeps the latest identical large read and omits earlier copies", () => {
    const input = [tool("c1", "read", big), tool("c2", "read", big), tool("c3", "read", big)]
    const output = dedupe(input)
    expect(output.map(valueOf)).toEqual([
      "[Identical read output omitted; see later tool result c3.]",
      "[Identical read output omitted; see later tool result c3.]",
      big,
    ])
    expect(input.map(valueOf)).toEqual([big, big, big])
  })

  test("keeps distinct values and different tool names independent", () => {
    const output = dedupe([tool("a", "read", big), tool("b", "grep", big), tool("c", "read", other)])
    expect(output.map(valueOf)).toEqual([big, big, other])
  })

  test("leaves results under 2048 characters untouched", () => {
    const small = "short"
    const output = dedupe([tool("s1", "glob", small), tool("s2", "glob", small)])
    expect(output.map(valueOf)).toEqual([small, small])
  })

  test("does not dedupe tools outside the read/grep/glob/webfetch allowlist", () => {
    const output = dedupe([tool("b1", "bash", big), tool("b2", "bash", big)])
    expect(output.map(valueOf)).toEqual([big, big])
  })
})
