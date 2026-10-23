import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { readCache, writeCache } from "../src/cache.js"
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
  const path = join(directory, "opencode-cpa/models.json")
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
  const options = { baseURL: "http://localhost:8317/v1", apiKey: "test-only-key", refreshIntervalMinutes: 1 }
  const provider = {
    async transform(cb: typeof callback) { callback = cb; return { async dispose() { disposals++ } } },
    async reload() { reloads++ },
  } as Plugin.Context["provider"]
  const dependencies = {
    env: { XDG_DATA_HOME: directory },
    log: (message: string) => { logs.push(message) },
    fetch: (async () => {
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
    path, options, dependencies, provider, logs,
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
    async start() { cleanup = await setup({ options, provider }, dependencies) },
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
  assert.equal(f.requests, 3)
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
  assert.equal(info.package, "@ai-sdk/google")
  assert.equal(info.settings?.apiKey, f.options.apiKey)
  assert.equal(info.settings?.baseURL, "http://localhost:8317/v1beta")
  assert.equal(models[0].package, "@ai-sdk/google")
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
  assert.equal(f.requests, 6)
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
  assert.equal(await setup({ options, provider: f.provider }, f.dependencies), undefined)
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
