import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.js"

test("plugin 提供固定 id 與 setup", () => {
  assert.equal(plugin.id, "opencode-cpa")
  assert.equal(typeof plugin.setup, "function")
})
