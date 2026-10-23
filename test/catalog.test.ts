import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { Model, Provider } from "@opencode/schema"
import { Schema } from "effect"
import { parseConfig } from "../src/config.js"
import { fetchCatalog, type CPACatalog } from "../src/cpa-client.js"
import { buildModels, buildProviderInfo, catalogFingerprint } from "../src/catalog.js"

const config = parseConfig({ baseURL: "http://localhost:8317/v1/" }, {})

test("provider 使用 Google 原生格式，認證可省略", () => {
  assert.deepEqual(buildProviderInfo(config), {
    id: "cpa", integrationID: "cpa", name: "CLIProxyAPI", activation: "enabled", package: "@opencode/ai/providers/google",
    settings: { baseURL: "http://localhost:8317/v1beta" },
  })
  assert.equal(buildProviderInfo(config).settings?.apiKey, undefined)
})

test("真實 schema 編碼 provider 與 materialized model 不含認證", () => {
  const secret = "private-cpa-credential"
  const provider = buildProviderInfo(parseConfig({ apiKey: secret }, { CPA_API_KEY: secret }))
  const models = buildModels({ models: [{ id: "a", owned_by: "antigravity" }] }, config)
    .map((model) => ({ ...model, settings: { ...provider.settings, ...model.settings } }))
  const encoded = [Schema.encodeSync(Provider.Info)(provider), ...models.map((model) => Schema.encodeSync(Model.Info)(model))]
  assert.doesNotMatch(JSON.stringify(encoded), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(encoded), /apiKey|private-cpa-credential/)
  assert.equal(models[0].settings?.apiKey, undefined)
})

test("catalog 依 owned_by 過濾、設定 per-model package 與 limits，並使用 schema 預設值", async () => {
  const mixed = JSON.parse(await readFile(new URL("./fixtures/mixed-models.json", import.meta.url), "utf8"))
  const raw = await fetchCatalog(config, { fetch: async (url) => Response.json(String(url).includes("v1beta") ? {} : mixed) })
  const models = buildModels(raw, config)
  assert.deepEqual(models.map((model) => model.id), ["a-gpt-oss", "invalid-limits", "z-claude"])
  for (const model of models) {
    assert.equal(model.modelID, model.id)
    assert.equal(model.providerID, "cpa")
    assert.equal(model.package, "@opencode/ai/providers/google")
    assert.deepEqual(model.settings, { baseURL: "http://localhost:8317/v1beta" })
    assert.deepEqual(model.capabilities, { tools: true, input: ["text"], output: ["text"] })
    assert.deepEqual(model.cost, [])
    assert.deepEqual(model.variants, [])
    assert.equal(model.enabled, true)
    assert.equal(model.status, "active")
    assert.equal(model.time.released, 0)
  }
  assert.equal(models[0].name, "a-gpt-oss")
  assert.equal(models[2].name, "測試 Claude")
  assert.deepEqual(models[2].limit, { context: 800000, output: 64000 })
  const defaults = Model.Info.default(Provider.ID.make("cpa"), Model.ID.make("a"))
  assert.deepEqual(models[0].limit, defaults.limit)
  assert.deepEqual(models[1].limit, defaults.limit)
})

test("catalog 轉換 modalities、去重與排序，忽略未知詞彙", () => {
  const raw: CPACatalog = { models: [
    { id: "a", owned_by: "antigravity", input: ["TEXT", "IMAGE", "AUDIO", "VIDEO", "PDF", "image", "unknown"], output: ["IMAGE", "TEXT"] },
    { id: "b", owned_by: "antigravity", input: [], output: ["unknown"] },
  ] }
  const models = buildModels(raw, config)
  assert.deepEqual(models[0].capabilities.input, ["audio", "image", "pdf", "text", "video"])
  assert.deepEqual(models[0].capabilities.output, ["image", "text"])
  assert.deepEqual(models[1].capabilities, { tools: true, input: ["text"], output: ["text"] })
})

test("catalog 排序與 fingerprint 不受來源順序、欄位順序或 modalities 順序影響", () => {
  const raw: CPACatalog = { models: [
    { id: "z", owned_by: "antigravity", input: ["text", "image"] },
    { id: "a", owned_by: "antigravity" },
  ] }
  const first = buildModels(raw, config)
  const second = buildModels({ models: [...raw.models].reverse().map((model) => ({ ...model, input: model.input?.slice().reverse() })) }, config)
  assert.deepEqual(first, second)
  assert.equal(catalogFingerprint(first), catalogFingerprint([...second].reverse().map((model) => ({ name: model.name, ...model }))))
  assert.notEqual(catalogFingerprint(first), catalogFingerprint([{ ...first[0], name: "changed" }, first[1]]))
  assert.deepEqual(raw.models[0].input, ["text", "image"])
})
