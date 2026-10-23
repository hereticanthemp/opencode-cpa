import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { cachePath, readCache, writeCache } from "../src/cache.js"
import { buildModels, buildProviderInfo } from "../src/catalog.js"
import { parseConfig } from "../src/config.js"
import { setup } from "../src/plugin.js"

type Editor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0]

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await delay(5)
  }
  assert.fail("等待條件逾時")
}

async function fixture(t: TestContext, cached?: string) {
  const directory = await mkdtemp(join(process.cwd(), "test/.plugin-test-"))
  const path = cachePath({ XDG_DATA_HOME: directory }, undefined, "http://localhost:8317")
  if (cached) await writeCache({ models: [{ id: cached, owned_by: "antigravity" }] }, path)
  let callback: Parameters<Plugin.Context["provider"]["transform"]>[0] | undefined
  let tick: (() => void) | undefined
  let reloads = 0
  let disposals = 0
  let requests = 0
  let unrefs = 0
  let cancelled = false
  let id = "new-model"
  let fails = false
  let gate: Promise<void> | undefined
  let cleanup: Plugin.Cleanup | void
  const logs: string[] = []
  const options = { baseURL: "http://localhost:8317/v1", refreshIntervalMinutes: 1 }
  const provider = {
    async transform(cb: typeof callback) { callback = cb; return { async dispose() { disposals++ } } },
    async reload() { reloads++ },
  } as Plugin.Context["provider"]
  let integrationRegistered = false
  let key: string | undefined = "test-only-key"
  let connectionFails = false
  let connectionGate: Promise<void> | undefined
  let eventListener: ((event: unknown) => void) | undefined
  let integrationDisposed = false
  const integration = {
    async transform(cb: Parameters<Plugin.Context["integration"]["transform"]>[0]) {
      const methods: unknown[] = []
      cb({
        update(id, update) {
          assert.equal(id, "cpa")
          const ref = { id, name: "" }
          update(ref)
          assert.equal(ref.name, "CLIProxyAPI")
        },
        method: { update(input) { methods.push(input) } },
      } as Parameters<typeof cb>[0])
      assert.deepEqual(methods, [
        { integrationID: "cpa", method: { type: "key", label: "CLIProxyAPI API key" } },
        { integrationID: "cpa", method: { type: "env", names: ["CPA_API_KEY"] } },
      ])
      integrationRegistered = true
      return { async dispose() { integrationDisposed = true } }
    },
    connection: {
      async active(id: string) {
        assert.equal(integrationRegistered, true)
        assert.equal(id, "cpa")
        await connectionGate
        if (connectionFails) throw new Error("sensitive-connection")
        return key ? { type: "env" as const, name: "CPA_API_KEY" } : undefined
      },
      async resolve() { return key ? { type: "key" as const, key } : undefined },
    },
  } as Plugin.Context["integration"]
  const event = {
    async *subscribe({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) {
        const value = await new Promise<unknown>((resolve) => {
          eventListener = resolve
          signal.addEventListener("abort", () => resolve(undefined), { once: true })
        })
        if (value) yield value
      }
    },
  } as Plugin.Context["event"]
  const dependencies = {
    coldStartBudgetMs: 3_000,
    writeCache,
    env: { XDG_DATA_HOME: directory },
    log: (message: string) => { logs.push(message) },
    fetch: (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), key && !connectionFails ? `Bearer ${key}` : null)
      requests++
      await gate
      return Response.json({ data: [{ id, owned_by: "antigravity" }, { id: "excluded", owned_by: "other" }] }, { status: fails ? 503 : 200 })
    }) as typeof fetch,
    setInterval: ((cb: () => void, ms: number) => {
      assert.equal(ms, 60_000)
      tick = cb
      return { unref() { unrefs++ } }
    }) as unknown as typeof setInterval,
    clearInterval: (() => { cancelled = true; tick = undefined }) as typeof clearInterval,
  }
  t.after(async () => { await cleanup?.(); await rm(directory, { recursive: true, force: true }) })
  return {
    path, options, dependencies, provider, integration, event, logs,
    get integrationDisposed() { return integrationDisposed },
    set key(value: string | undefined) { key = value },
    set connectionFails(value: boolean) { connectionFails = value },
    set connectionGate(value: Promise<void> | undefined) { connectionGate = value },
    emit(integrationID: string) { eventListener?.({ type: "credential.switched", data: { integrationID } }) },
    get registered() { return Boolean(callback) },
    get reloads() { return reloads },
    get requests() { return requests },
    get disposals() { return disposals },
    get unrefs() { return unrefs },
    get cancelled() { return cancelled },
    set id(value: string) { id = value },
    set fails(value: boolean) { fails = value },
    set gate(value: Promise<void> | undefined) { gate = value },
    tick() { tick?.() },
    async start() { cleanup = await setup({ options, provider, integration, event }, dependencies) },
    async stop() { const stop = cleanup; cleanup = undefined; await stop?.() },
    added() {
      const added: Parameters<Editor["add"]>[0][] = []
      const result = callback?.({ add(input) { added.push(input) } } as Parameters<NonNullable<typeof callback>>[0])
      assert.equal(result, undefined, "transform 必須同步")
      return added
    },
  }
}

test("有快取時先註冊，背景內容變更才 reload，相同內容不 reload", async (t) => {
  const f = await fixture(t, "cached-model")
  const gate = deferred()
  f.gate = gate.promise
  await f.start()
  assert.equal(f.registered, true)
  assert.equal(f.added()[0].models[0].id, "cached-model")
  await until(() => f.requests === 3)
  gate.resolve()
  await until(() => f.reloads === 1)
  assert.equal(f.added()[0].models[0].id, "new-model")
  assert.equal((await readCache(f.path))?.models[0].id, "new-model")
  f.tick()
  await until(() => f.requests === 6)
  await delay(20)
  assert.equal(f.reloads, 1)
})

test("無快取時等待抓取、寫快取，transform 產出正確設定與模型", async (t) => {
  const f = await fixture(t)
  await f.start()
  const config = parseConfig(f.options, {})
  const catalog = { models: [
    { id: "new-model", owned_by: "antigravity" },
    { id: "excluded", owned_by: "other" },
  ] }
  assert.deepEqual(await readCache(f.path), catalog)
  assert.deepEqual(f.added(), [{ info: buildProviderInfo(config), models: buildModels(catalog, config) }])
  const { info, models } = f.added()[0]
  assert.equal(info.package, "@opencode/ai/providers/google")
  assert.equal(info.integrationID, "cpa")
  assert.equal(info.settings?.apiKey, undefined)
  assert.equal(info.settings?.baseURL, "http://localhost:8317/v1beta")
  assert.equal(models[0].package, "@opencode/ai/providers/google")
  assert.deepEqual(models[0].settings, { baseURL: "http://localhost:8317/v1beta" })
  assert.doesNotMatch(await readFile(f.path, "utf8"), /apiKey|test-only-key/)
  assert.equal(f.reloads, 0)
  assert.equal(f.unrefs, 1)
})

test("無快取且失敗時不丟錯；定期更新成功後才出現 provider", async (t) => {
  const f = await fixture(t)
  f.fails = true
  await f.start()
  assert.equal(f.registered, true)
  assert.deepEqual(f.added(), [])
  assert.equal(f.logs.length, 1)
  assert.equal(await readCache(f.path), null)
  f.fails = false
  f.tick()
  await until(() => f.reloads === 1)
  assert.equal(f.added()[0].info.id, "cpa")
})

test("更新不重疊，失敗保留舊目錄", async (t) => {
  const f = await fixture(t)
  await f.start()
  const gate = deferred()
  f.gate = gate.promise
  f.fails = true
  f.tick()
  f.tick()
  f.tick()
  await until(() => f.requests === 6)
  gate.resolve()
  await until(() => f.logs.length === 1)
  assert.equal(f.reloads, 0)
  assert.equal(f.added()[0].models[0].id, "new-model")
})

test("cleanup 停止 interval、dispose registration，忽略晚到結果", async (t) => {
  const f = await fixture(t, "cached-model")
  const gate = deferred()
  f.gate = gate.promise
  await f.start()
  await until(() => f.requests === 3)
  await f.stop()
  assert.equal(f.cancelled, true)
  assert.equal(f.disposals, 1)
  f.tick()
  gate.resolve()
  await delay(30)
  assert.equal(f.requests, 3)
  assert.equal(f.reloads, 0)
  assert.equal((await readCache(f.path))?.models[0].id, "cached-model")
  assert.deepEqual(f.added(), [])
})

test("設定讀取錯誤時不丟錯、不註冊、不輸出例外內容", async (t) => {
  const f = await fixture(t)
  const options = { get baseURL(): string { throw new Error("sensitive-setting") } }
  assert.equal(await setup({ options, provider: f.provider, integration: f.integration, event: f.event }, f.dependencies), undefined)
  assert.equal(f.registered, false)
  assert.equal(f.requests, 0)
  assert.equal(f.logs.length, 1)
  assert.doesNotMatch(f.logs.join(""), /sensitive-setting/)
})

test("更新間隔為 0 時不排程", async (t) => {
  const f = await fixture(t)
  f.options.refreshIntervalMinutes = 0
  await f.start()
  assert.equal(f.unrefs, 0)
})

test("冷啟動只等待預算，主來源成功時先發布，metadata 完成後 reload", async (t) => {
  const f = await fixture(t)
  const gate = deferred()
  f.dependencies.coldStartBudgetMs = 25
  f.dependencies.fetch = async (url, init) => {
    if (new Headers(init?.headers).has("anthropic-version") || String(url).includes("v1beta")) {
      await gate.promise
      return Response.json(String(url).includes("v1beta")
        ? { models: [{ name: "models/a", supportedInputModalities: ["text", "image"] }] }
        : { data: [{ id: "a", display_name: "補充名稱", max_tokens: 100 }] })
    }
    return Response.json({ data: [{ id: "a", owned_by: "antigravity" }] })
  }
  const before = Date.now()
  await f.start()
  assert.ok(Date.now() - before < 500)
  assert.equal(f.added()[0].models[0].name, "a")
  assert.deepEqual(f.added()[0].models[0].capabilities.input, ["text"])
  gate.resolve()
  await until(() => f.reloads === 1)
  assert.equal(f.added()[0].models[0].name, "補充名稱")
  assert.deepEqual(f.added()[0].models[0].capabilities.input, ["image", "text"])
})

test("冷啟動主來源超出預算時中止請求並註冊空 transform", async (t) => {
  const f = await fixture(t)
  f.dependencies.coldStartBudgetMs = 20
  let aborted = 0
  f.dependencies.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted++; reject(init.signal?.reason) }, { once: true })
  })
  await f.start()
  assert.deepEqual(f.added(), [])
  await until(() => aborted === 3)
  assert.equal(f.reloads, 0)
})

test("相同 catalog 在快取寫入失敗後重試，不重複 reload", async (t) => {
  const f = await fixture(t)
  let writes = 0
  f.dependencies.writeCache = async (catalog, path) => {
    writes++
    return writes === 1 ? false : writeCache(catalog, path)
  }
  await f.start()
  assert.equal(writes, 1)
  assert.equal(await readCache(f.path), null)
  f.tick()
  await until(() => writes === 2)
  await until(async () => (await readCache(f.path)) !== null)
  assert.equal(f.reloads, 0)
})

test("cleanup 中止背景請求並 dispose integration", async (t) => {
  const f = await fixture(t, "cached")
  let aborted = 0
  f.dependencies.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted++; reject(init.signal?.reason) }, { once: true })
  })
  await f.start()
  await delay(5)
  await f.stop()
  await until(() => aborted === 3)
  assert.equal(f.integrationDisposed, true)
  assert.equal(f.reloads, 0)
})

test("冷啟動快取寫入較慢時，不把完整 metadata 降成預設值", async (t) => {
  const f = await fixture(t)
  const gate = deferred()
  f.dependencies.coldStartBudgetMs = 20
  f.dependencies.fetch = async () => Response.json({ data: [{ id: "a", owned_by: "antigravity", display_name: "完整名稱" }] })
  f.dependencies.writeCache = async (catalog, path) => {
    await gate.promise
    return writeCache(catalog, path)
  }
  await f.start()
  assert.equal(f.added()[0].models[0].name, "完整名稱")
  gate.resolve()
  await until(async () => (await readCache(f.path))?.models[0].display_name === "完整名稱")
})

test("定期更新 metadata 失敗時沿用上次資料，不降級圖片能力", async (t) => {
  const f = await fixture(t)
  let unavailable = false
  f.dependencies.fetch = async (url, init) => {
    const google = String(url).includes("v1beta")
    const anthropic = new Headers(init?.headers).has("anthropic-version")
    if (unavailable && (google || anthropic)) throw new Error("offline")
    return Response.json(google
      ? { models: [{ name: "models/a", supportedInputModalities: ["text", "image"] }] }
      : { data: [{ id: "a", owned_by: "antigravity", display_name: "名稱", max_input_tokens: 100, max_tokens: 20 }] })
  }
  await f.start()
  const before = f.added()
  unavailable = true
  f.tick()
  await delay(30)
  assert.deepEqual(f.added(), before)
  assert.equal(f.reloads, 0)
  assert.deepEqual(f.added()[0].models[0].capabilities.input, ["image", "text"])
})

test("每次更新重新讀 connection；沒有 connection 或讀取失敗時不帶認證", async (t) => {
  const f = await fixture(t)
  f.key = undefined
  await f.start()
  assert.equal(f.requests, 3)
  f.key = "changed-key"
  f.tick()
  await until(() => f.requests === 6)
  await delay(20)
  f.connectionFails = true
  f.tick()
  await until(() => f.requests === 9)
  await delay(20)
  assert.deepEqual(f.logs, [])
})

test("resolve 失敗不丟錯，也不帶認證", async (t) => {
  const f = await fixture(t)
  f.integration.connection.resolve = async () => { throw new Error("secret") }
  f.dependencies.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).has("authorization"), false)
    return Response.json({ data: [{ id: "a", owned_by: "antigravity" }] })
  }
  await f.start()
  assert.equal(f.added()[0].models[0].id, "a")
  assert.deepEqual(f.logs, [])
})

test("非 key credential 不帶認證", async (t) => {
  const f = await fixture(t)
  f.integration.connection.resolve = async () => ({ type: "oauth", access: "not-a-key", refresh: "refresh", expires: 0 })
  f.dependencies.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).has("authorization"), false)
    return Response.json({ data: [{ id: "a", owned_by: "antigravity" }] })
  }
  await f.start()
  assert.equal(f.added()[0].models[0].id, "a")
})

test("connection 讀取超出冷啟動預算時不等待，也不在晚到時發送請求", async (t) => {
  const f = await fixture(t)
  const gate = deferred()
  f.connectionGate = gate.promise
  f.dependencies.coldStartBudgetMs = 20
  const before = Date.now()
  await f.start()
  assert.ok(Date.now() - before < 500)
  assert.deepEqual(f.added(), [])
  gate.resolve()
  await delay(20)
  assert.equal(f.requests, 0)
})

test("只在 cpa credential 切換時更新，cleanup 後停止訂閱", async (t) => {
  const f = await fixture(t)
  await f.start()
  f.emit("other")
  await delay(10)
  assert.equal(f.requests, 3)
  f.id = "after-credential"
  f.emit("cpa")
  await until(() => f.reloads === 1)
  assert.equal(f.requests, 6)
  await f.stop()
  f.emit("cpa")
  await delay(10)
  assert.equal(f.requests, 6)
})

test("更新進行中收到 credential 事件時，合併成一次後續更新", async (t) => {
  const f = await fixture(t)
  await f.start()
  const gate = deferred()
  f.gate = gate.promise
  f.tick()
  await until(() => f.requests === 6)
  f.emit("cpa")
  await delay(5)
  f.emit("cpa")
  await delay(5)
  gate.resolve()
  await until(() => f.requests === 9)
  await delay(20)
  assert.equal(f.requests, 9)
})
