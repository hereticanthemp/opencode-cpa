import assert from "node:assert/strict"
import test from "node:test"
import { resolveClaudeModelIDPrefix } from "../src/claude-model-id.js"

test("解碼 cloaked id，並保留 thinking 後綴", () => {
  const encoded = "claude-fable-5-dd-egami-hsalf-1.3-inimeg"
  assert.equal(resolveClaudeModelIDPrefix(encoded), "gemini-3.1-flash-image")
  for (const suffix of ["(8192)", "(high)", "()"]) {
    assert.equal(resolveClaudeModelIDPrefix(`${encoded}${suffix}`), `gemini-3.1-flash-image${suffix}`)
  }
  assert.equal(resolveClaudeModelIDPrefix(`${encoded}(a(b)`), "a(gemini-3.1-flash-image(b)")
  assert.equal(resolveClaudeModelIDPrefix("claude-fable-5-dd-😀文中(high)"), "中文😀(high)")
})

test("非 cloaked id 與空 encoded id 保持不變", () => {
  for (const id of ["", "claude-opus-5-5-high", "gemini-3-flash", "gemini-3-flash(8192)",
    "claude-fable-5-dd-", "claude-fable-5-dd-(high)", "prefix-claude-fable-5-dd-abc"]) {
    assert.equal(resolveClaudeModelIDPrefix(id), id)
  }
})

test("未閉合括號或非結尾後綴視為 encoded id 的一部分", () => {
  assert.equal(resolveClaudeModelIDPrefix("claude-fable-5-dd-cba(high"), "hgih(abc")
  assert.equal(resolveClaudeModelIDPrefix("claude-fable-5-dd-cba(high)x"), "x)hgih(abc")
})
