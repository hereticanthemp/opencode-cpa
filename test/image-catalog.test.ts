import assert from "node:assert/strict"
import test from "node:test"
import { imageModels, buildModels } from "../src/catalog.js"
import { parseConfig } from "../src/config.js"

test("imageModels 依渠道與輸出能力篩選、排序及去重，聊天清單排除圖片模型", () => {
  const catalog = { models: [
    { id: "z", owned_by: "antigravity", output: ["IMAGE"] },
    { id: "a", owned_by: "antigravity", output: ["text", "image"] },
    { id: "a", owned_by: "antigravity", output: ["image"] },
    { id: "other", owned_by: "other", output: ["image"] },
    { id: "chat", owned_by: "antigravity", input: ["image"] },
  ] }
  assert.deepEqual(imageModels(catalog), ["a", "z"])
  assert.deepEqual(buildModels(catalog, parseConfig({}, {})).map((model) => model.id), ["chat"])
})
