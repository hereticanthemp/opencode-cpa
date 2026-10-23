import type { Plugin } from "@opencode/plugin"
import { setTimeout as delay } from "node:timers/promises"
import { cachePath, readCache, writeCache } from "./cache.js"
import { buildModels, buildProviderInfo, catalogFingerprint } from "./catalog.js"
import { parseConfig, resolveConfig, type Config } from "./config.js"
import { fetchCatalog, type CPACatalog } from "./cpa-client.js"

type Context = Pick<Plugin.Context, "options" | "provider" | "integration" | "event">
interface Dependencies {
  env?: NodeJS.ProcessEnv
  cachePath?: string
  fetch?: typeof fetch
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  log?: (message: string) => void
  coldStartBudgetMs?: number
  writeCache?: typeof writeCache
  retryWait?: (ms: number, signal: AbortSignal) => Promise<void>
}

export async function setup(ctx: Context, dependencies: Dependencies = {}): Promise<Plugin.Cleanup | void> {
  // 只記錄固定訊息，不轉印設定值、遠端回應或例外內容。
  const log = dependencies.log ?? ((message: string) => console.error(`[opencode-cpa] ${message}`))
  const env = dependencies.env ?? process.env
  let staticConfig: Config
  try {
    staticConfig = parseConfig(ctx.options, env)
  } catch {
    log("設定讀取失敗；不註冊 provider。")
    return
  }

  let config = staticConfig
  let path: string | undefined
  let catalog: CPACatalog | null = null
  let fingerprint = catalogFingerprint([])
  let writtenFingerprint: string | undefined
  let generation = 0
  let cachedReady!: () => void
  const cachedStartup = new Promise<void>((resolve) => { cachedReady = resolve })
  let disposed = false
  let fetching = false
  let registered = false
  let controller: AbortController | undefined
  let primary: CPACatalog | undefined
  let pendingRefresh = false
  let writing: Promise<boolean> | undefined
  const integration = await ctx.integration.transform((editor) => {
    editor.update("cpa", (value) => { value.name = "CLIProxyAPI" })
    editor.method.update({ integrationID: "cpa", method: { type: "key", label: "CLIProxyAPI API key", form: [{
      key: "cpaBaseURL", type: "string", title: "CPA URL",
      description: "例如 http://127.0.0.1:8317 或 https://cpa.example.com",
      format: "uri", placeholder: "http://127.0.0.1:8317", required: false,
    }] } })
    editor.method.update({ integrationID: "cpa", method: { type: "env", names: ["CPA_API_KEY"] } })
  })

  type ConnectionSettings = { type: "credential" | "none"; apiKey?: string; config: Config } | { type: "error" }
  async function connectionSettings(): Promise<ConnectionSettings> {
    try {
      const connection = await ctx.integration.connection.active("cpa")
      if (disposed) return { type: "error" }
      if (!connection) return { type: "none", config: staticConfig }
      const credential = await ctx.integration.connection.resolve(connection)
      if (disposed) return { type: "error" }
      if (!credential) throw new Error("Credential unavailable")
      let effective: Config
      try {
        effective = resolveConfig(staticConfig, connection.type === "credential" ? credential.metadata?.cpaBaseURL : undefined)
      } catch {
        log("credential 的 CPA URL 無效；保留目前來源，本次不抓取模型。")
        try {
          await ctx.integration.connection.status({ integrationID: "cpa", connection,
            status: { status: "needs_auth", message: "CLIProxyAPI CPA URL is invalid. Enter a valid URL." } })
        } catch {}
        return { type: "error" }
      }
      if (credential.type !== "key") return { type: "credential", config: effective }
      const empty = credential.key.trim() === ""
      if (empty) log("CLIProxyAPI API key 為空；請重新輸入有效的 key。模型列表請求不帶認證。")
      try {
        await ctx.integration.connection.status({
          integrationID: "cpa", connection,
          status: empty ? { status: "needs_auth", message: "CLIProxyAPI API key is empty. Enter a valid key." } : undefined,
        })
      } catch {
        // UI 狀態回報失敗不改變模型列表請求的認證判斷。
      }
      return { type: "credential", config: effective, ...(empty ? {} : { apiKey: credential.key }) }
    } catch {
      if (!disposed) log("credential 讀取失敗；保留目前來源，本次不抓取模型。")
      return { type: "error" }
    }
  }

  async function refresh(reload: boolean): Promise<void> {
    if (disposed || fetching) return
    fetching = true
    controller = new AbortController()
    const signal = controller.signal
    const revision = generation
    const current = () => !disposed && revision === generation && !signal.aborted
    primary = undefined
    try {
      // connection 讀取也受冷啟動與 cleanup 的 signal 限制；晚到的 key 不啟動請求。
      const settings = await new Promise<Awaited<ReturnType<typeof connectionSettings>>>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        void connectionSettings().then(resolve).finally(() => signal.removeEventListener("abort", abort))
      })
      signal.throwIfAborted()
      if (!current() || settings.type === "error") return
      const changedSource = path !== undefined && settings.config.baseURL !== config.baseURL
      if (path === undefined || changedSource) {
        const nextPath = dependencies.cachePath ?? cachePath(env, undefined, settings.config.baseURL)
        const cached = await readCache(nextPath)
        if (!current()) return
        config = settings.config
        path = nextPath
        catalog = cached
        fingerprint = catalogFingerprint(cached ? buildModels(cached, config) : [])
        writtenFingerprint = cached ? catalogFingerprint(cached.models) : undefined
        if (cached) cachedReady()
        // 切換來源後只發布新網址的快取；沒有快取時移除舊 provider。
        if (registered) await ctx.provider.reload()
      }
      if (!current()) return
      const requestConfig = config
      const requestPath = path!
      const next = await fetchCatalog(requestConfig, {
        apiKey: settings.apiKey, fetch: dependencies.fetch, signal, previous: catalog,
        onPrimary: (value) => { if (current()) primary = value },
      })
      if (!current()) return
      const nextFingerprint = catalogFingerprint(buildModels(next, requestConfig))
      const changed = nextFingerprint !== fingerprint
      catalog = next
      fingerprint = nextFingerprint
      if (disposed) return
      const cacheFingerprint = catalogFingerprint(next.models)
      if (writtenFingerprint !== cacheFingerprint) {
        const task = writing = (dependencies.writeCache ?? writeCache)(next, requestPath)
        try {
          if (await task) { if (current()) writtenFingerprint = cacheFingerprint }
          else if (!disposed) log("模型快取寫入失敗。")
        } finally {
          if (writing === task) writing = undefined
        }
      }
      if (current() && (reload || registered) && changed) await ctx.provider.reload()
    } catch {
      if (!disposed && revision === generation) log("模型更新失敗；保留目前來源的模型快取，沒有快取時不註冊 provider。")
    } finally {
      fetching = false
      if (pendingRefresh && !disposed) {
        pendingRefresh = false
        void refresh(true)
      }
    }
  }

  function requestRefresh(invalidate = false): void {
    if (disposed) return
    if (invalidate) {
      generation++
      primary = undefined
      controller?.abort()
    }
    if (fetching) pendingRefresh = true
    else void refresh(true)
  }

  const events = new AbortController()
  const retryWait = dependencies.retryWait ?? ((ms, signal) => delay(ms, undefined, { signal }))
  // 2.1.3 的 adapter 透過 next() 同步啟動 Effect stream 與 Bus 訂閱；subscribe() 本身是 lazy。
  // 在第一次讀取 connection 前先呼叫 next()，不可等待第一個事件才開始讀取。
  const watching = (async () => {
    let backoff = 1_000
    let retrying = false
    while (!disposed) {
      try {
        const iterator = ctx.event.subscribe({ signal: events.signal })[Symbol.asyncIterator]()
        try {
          let next = iterator.next()
          // 斷線期間可能遺失 credential 事件；重新訂閱後補讀一次。
          if (retrying) requestRefresh(true)
          while (!disposed) {
            const result = await next
            if (result.done) return
            const event = result.value
            if (event.type === "credential.switched" && event.data.integrationID === "cpa") requestRefresh(true)
            next = iterator.next()
          }
        } finally {
          await iterator.return?.()
        }
      } catch {
        if (disposed) return
        log("認證事件訂閱失敗；將重試訂閱。")
        try { await retryWait(backoff, events.signal) } catch { return }
        backoff = Math.min(60_000, backoff * 2)
        retrying = true
      }
    }
  })()

  {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      refresh(false),
      cachedStartup,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (primary && catalog === null) {
            catalog = primary
            fingerprint = catalogFingerprint(buildModels(primary, config))
          } else if (!primary) controller?.abort()
          resolve()
        }, Math.min(3_000, config.timeoutMs, dependencies.coldStartBudgetMs ?? 3_000))
      }),
    ])
    clearTimeout(timer)
  }
  const registration = await ctx.provider.transform((editor) => {
    if (disposed || !catalog) return
    const models = buildModels(catalog, config)
    if (models.length) editor.add({ info: buildProviderInfo(config), models })
  })
  registered = true
  const schedule = dependencies.setInterval ?? setInterval
  const cancel = dependencies.clearInterval ?? clearInterval
  const timer = config.refreshIntervalMinutes > 0
    ? schedule(() => void refresh(true), Math.min(2_147_483_647, Math.floor(config.refreshIntervalMinutes * 60_000)))
    : undefined
  timer?.unref()

  return async () => {
    disposed = true
    events.abort()
    controller?.abort()
    if (timer) cancel(timer)
    await watching
    await writing?.catch(() => {})
    await registration.dispose()
    await integration.dispose()
  }
}
