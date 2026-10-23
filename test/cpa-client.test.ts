import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { parseConfig } from "../src/config.js"
import { fetchCatalog } from "../src/cpa-client.js"
import { buildModels } from "../src/catalog.js"

const config = parseConfig({}, {})
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}-models.json`, import.meta.url), "utf8"))
const json = (value: unknown) => Response.json(value)
const isAnthropic = (init?: RequestInit) => new Headers(init?.headers).has("anthropic-version")

test("fetchCatalog 平行抓取三個來源，正確帶入認證與 timeout", async () => {
  const primary = await fixture("openai")
  const metadata = await fixture("anthropic")
  const google = await fixture("google")
  const started: string[] = []
  const signals: AbortSignal[] = []
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    const headers = new Headers(init?.headers)
    started.push(`${path}${isAnthropic(init) ? ":anthropic" : ""}`)
    assert.equal(headers.get("authorization"), "Bearer test-key")
    assert.ok(init?.signal instanceof AbortSignal)
    signals.push(init.signal)
    if (started.length === 3) release()
    await barrier
    if (path === "/v1/models") {
      if (isAnthropic(init)) {
        assert.equal(headers.get("anthropic-version"), "2023-06-01")
        return json(metadata)
      }
      assert.equal(headers.get("anthropic-version"), null)
      return json(primary)
    }
    assert.equal(headers.get("anthropic-version"), null)
    return json(google)
  }
  const catalog = await fetchCatalog(config, { apiKey: "test-key", fetch: request })
  assert.deepEqual(started, ["/v1/models", "/v1/models:anthropic", "/v1beta/models"])
  assert.equal(new Set(signals).size, 1)
  assert.equal(catalog.models.length, 9)
  assert.deepEqual(catalog.models.find((model) => model.id === "claude-opus-5-5-high")?.input, ["text", "image"])
  assert.equal(catalog.models.some((model) => model.id.includes("fable")), false)
  assert.deepEqual(catalog.models.find((model) => model.id === "gemini-3-flash")?.input, ["text", "image", "audio", "video"])
  assert.deepEqual(catalog.models.find((model) => model.id === "gemini-3.1-flash-image")?.output, ["text", "image"])
})

test("fetchCatalog 不帶未設定的認證，Google metadata 只依 id 配對", async () => {
  const catalog = await fetchCatalog(config, { fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).has("authorization"), false)
    return String(url).includes("v1beta") ? json({ models: [
      { name: "models/a", supportedInputModalities: ["TEXT", "PDF"], supportedOutputModalities: ["IMAGE"] },
    ] }) : json({ data: [{ id: "a", owned_by: "antigravity", max_tokens: 1 }] })
  } })
  assert.deepEqual(catalog.models[0], { id: "a", owned_by: "antigravity", max_tokens: 1, input: ["TEXT", "PDF"], output: ["IMAGE"] })
})

test("fetchCatalog 主來源網路、HTTP、JSON 與結構錯誤均拋出明確錯誤", async (t) => {
  const cases: [string, () => Response | Promise<Response>, RegExp][] = [
    ["網路", () => { throw new Error("secret from network") }, /CPA \/v1\/models：網路請求失敗/],
    ["HTTP", () => new Response("secret", { status: 401 }), /HTTP 401/],
    ["JSON", () => new Response("not json"), /JSON 不合法/],
    ["結構", () => json({ models: [] }), /缺少 data 模型列表/],
  ]
  for (const [name, response, pattern] of cases) await t.test(name, async () => {
    await assert.rejects(fetchCatalog(config, { fetch: async (url, init) => String(url).includes("v1beta") || isAnthropic(init) ? json({}) : response() }), (error: Error) => {
      assert.match(error.message, pattern)
      assert.doesNotMatch(error.message, /secret/)
      return true
    })
  })
})

test("fetchCatalog v1beta 網路、HTTP、JSON 與結構錯誤不影響主來源", async () => {
  const primary = await fixture("openai")
  const metadata = await fixture("anthropic")
  for (const secondary of [
    () => { throw new Error("offline") },
    () => new Response("unavailable", { status: 503 }),
    () => new Response("not json"),
    () => json({ models: [null, { name: 1 }, { name: "models/claude-opus-5-5-high", supportedInputModalities: [42] }] }),
  ]) {
    const catalog = await fetchCatalog(config, { fetch: async (url, init) => String(url).includes("v1beta") ? secondary() : json(isAnthropic(init) ? metadata : primary) })
    assert.equal(catalog.models.length, 9)
    assert.equal(catalog.models[0].input, undefined)
    assert.equal(catalog.models.find((model) => model.id === "gemini-3-flash")?.max_tokens, 65536)
  }
})

const pending: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
})

test("fetchCatalog 主來源 timeout 會失敗；任一 metadata timeout 仍成功", async () => {
  // AbortSignal.timeout 的 timer 不保留 event loop，測試明確保留一個短期 timer。
  const keepAlive = setInterval(() => {}, 1000)
  try {
    await assert.rejects(fetchCatalog({ ...config, timeoutMs: 15 }, { fetch: async (url, init) => {
      return String(url).includes("v1beta") || isAnthropic(init) ? json({}) : pending(url, init)
    } }), /請求逾時/)
    for (const source of ["anthropic", "google"]) {
      const catalog = await fetchCatalog({ ...config, timeoutMs: 15 }, { fetch: async (url, init) => {
        const metadata = isAnthropic(init) ? "anthropic" : String(url).includes("v1beta") ? "google" : undefined
        return metadata === source ? pending(url, init) : json({ data: [{ id: "a", owned_by: "antigravity" }] })
      } })
      assert.equal(catalog.models.length, 1)
      assert.equal(buildModels(catalog, config)[0].id, "a")
    }
  } finally {
    clearInterval(keepAlive)
  }
})

test("cloaking 開啟與停用的 Anthropic fixture 產生相同真實模型目錄", async () => {
  const primary = await fixture("openai")
  const google = await fixture("google")
  const fetchWith = async (name: string) => {
    const metadata = await fixture(name)
    return fetchCatalog(config, { fetch: async (url, init) => json(
      String(url).includes("v1beta") ? google : isAnthropic(init) ? metadata : primary,
    ) })
  }
  const cloaked = await fetchWith("anthropic")
  const uncloaked = await fetchWith("anthropic-uncloaked")
  assert.deepEqual(cloaked, uncloaked)
  assert.deepEqual(cloaked.models.map((model) => model.id).sort(), primary.data.map((model: { id: string }) => model.id).sort())
  assert.ok(cloaked.models.every((model) => model.display_name && model.max_input_tokens && model.max_tokens && model.input && model.output))
  const models = buildModels(cloaked, config)
  assert.equal(models.length, 9)
  assert.equal(models.find((model) => model.id === "gpt-oss-120b-medium")?.name, "GPT-OSS 120B (Medium)")
  assert.deepEqual(models.find((model) => model.id === "gemini-3.1-flash-image")?.limit, { context: 200000, output: 64000 })
  assert.deepEqual(models.find((model) => model.id === "gemini-3.1-flash-image")?.capabilities.output, ["image", "text"])
})

test("模型清單與渠道只依主來源，不使用 Anthropic owned_by 或額外模型", async () => {
  const primary = { data: [
    { id: "gemini-3-flash", owned_by: "antigravity", display_name: "主來源名稱不使用", max_tokens: 999 },
    { id: "not-agy", owned_by: "openai" },
    { id: "primary-only", owned_by: "antigravity" },
    { id: "missing-owner" },
  ] }
  const metadata = { data: [
    { id: "claude-fable-5-dd-hsalf-3-inimeg", owned_by: "openai", display_name: "Gemini metadata", max_tokens: 123 },
    { id: "not-agy", owned_by: "antigravity", display_name: "不應納入" },
    { id: "metadata-only", owned_by: "antigravity" },
    { id: "missing-owner", owned_by: "antigravity" },
  ] }
  const raw = await fetchCatalog(config, { fetch: async (url, init) => json(
    String(url).includes("v1beta") ? { models: [{ name: "models/google-only" }] } : isAnthropic(init) ? metadata : primary,
  ) })
  assert.deepEqual(raw.models.map((model) => model.id), primary.data.map((model) => model.id))
  const models = buildModels(raw, config)
  assert.deepEqual(models.map((model) => model.id), ["gemini-3-flash", "primary-only"])
  assert.equal(models[0].name, "Gemini metadata")
  assert.equal(models[0].limit.output, 123)
  assert.equal(models[0].providerID, "cpa")
  assert.equal(raw.models[0].owned_by, "antigravity")
})

test("Anthropic 網路、HTTP、JSON、結構與欄位錯誤使用預設名稱與 limit", async () => {
  const primary = await fixture("openai")
  const google = await fixture("google")
  for (const metadata of [
    () => { throw new Error("offline") },
    () => new Response("secret", { status: 401 }),
    () => new Response("invalid JSON"),
    () => json({ models: [] }),
    () => json({ data: [null, {}, { id: "gemini-3-flash", display_name: 42, max_input_tokens: -1, max_tokens: "100" }] }),
  ]) {
    const raw = await fetchCatalog(config, { fetch: async (url, init) => {
      if (isAnthropic(init)) return metadata()
      return json(String(url).includes("v1beta") ? google : primary)
    } })
    const models = buildModels(raw, config)
    assert.equal(models.length, 9)
    for (const model of models) {
      assert.equal(model.name, model.id)
      assert.deepEqual(model.limit, { context: 200000, output: 32000 })
    }
    assert.deepEqual(models.find((model) => model.id === "gemini-3-flash")?.capabilities.input, ["audio", "image", "text", "video"])
  }
})

test("metadata 暫時失敗保留同 id 的已知欄位，但不保留刪除的模型或渠道", async () => {
  const previous = { models: [
    { id: "a", owned_by: "other", display_name: "名稱", max_input_tokens: 100, max_tokens: 20, input: ["text", "image"], output: ["text"] },
    { id: "deleted", input: ["image"] },
  ] }
  const catalog = await fetchCatalog(config, { previous, fetch: async (url, init) => {
    if (isAnthropic(init) || String(url).includes("v1beta")) throw new Error("offline")
    return json({ data: [{ id: "a", owned_by: "antigravity" }, { id: "new", owned_by: "antigravity" }] })
  } })
  assert.deepEqual(catalog.models[0], { ...previous.models[0], owned_by: "antigravity" })
  assert.deepEqual(catalog.models[1], { id: "new", owned_by: "antigravity" })
})

test("主來源失敗時中止 metadata，等待所有請求結束後才 reject", async () => {
  let completed = 0
  const request: typeof fetch = async (url, init) => {
    if (!isAnthropic(init) && !String(url).includes("v1beta")) return new Response(null, { status: 503 })
    await pending(url, init).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      completed++
    })
    throw new Error("aborted")
  }
  await assert.rejects(fetchCatalog(config, { fetch: request }), /HTTP 503/)
  assert.equal(completed, 2)
})

test("外部 signal 中止所有進行中的請求", async () => {
  const controller = new AbortController()
  let aborted = 0
  const task = fetchCatalog(config, { signal: controller.signal, fetch: async (url, init) => {
    try { return await pending(url, init) } finally { aborted++ }
  } })
  controller.abort()
  await assert.rejects(task)
  assert.equal(aborted, 3)
})
