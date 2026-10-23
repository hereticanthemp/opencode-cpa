import type { Plugin } from "@opencode/plugin"
import { cachePath, readCache, writeCache } from "./cache.js"
import { buildModels, buildProviderInfo, catalogFingerprint } from "./catalog.js"
import { parseConfig, type Config } from "./config.js"
import { fetchCatalog, type CPACatalog } from "./cpa-client.js"
import { authenticate } from "./auth.js"

type Context = Pick<Plugin.Context, "options" | "provider" | "session">
interface Dependencies {
  env?: NodeJS.ProcessEnv
  cachePath?: string
  fetch?: typeof fetch
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  log?: (message: string) => void
  coldStartBudgetMs?: number
  writeCache?: typeof writeCache
}

export async function setup(ctx: Context, dependencies: Dependencies = {}): Promise<Plugin.Cleanup | void> {
  // 只記錄固定訊息，不轉印設定值、遠端回應或例外內容。
  const log = dependencies.log ?? ((message: string) => console.error(`[opencode-cpa] ${message}`))
  const env = dependencies.env ?? process.env
  let config: Config
  try {
    config = parseConfig(ctx.options, env)
  } catch {
    log("設定讀取失敗；不註冊 provider。")
    return
  }

  const path = dependencies.cachePath ?? cachePath(env, undefined, config.baseURL)
  let catalog: CPACatalog | null = await readCache(path)
  let fingerprint = catalogFingerprint(catalog ? buildModels(catalog, config) : [])
  let writtenFingerprint = catalog ? fingerprint : undefined
  let disposed = false
  let fetching = false
  let registered = false
  let controller: AbortController | undefined
  let primary: CPACatalog | undefined
  const authentication = await ctx.session.hook("http.request", (event) => {
    if (!disposed) authenticate(event.request, config)
  }, { providerID: "cpa" })

  async function refresh(reload: boolean): Promise<void> {
    if (disposed || fetching) return
    fetching = true
    controller = new AbortController()
    try {
      const next = await fetchCatalog(config, {
        fetch: dependencies.fetch, signal: controller.signal, previous: catalog,
        onPrimary: (value) => { primary = value },
      })
      if (disposed) return
      const nextFingerprint = catalogFingerprint(buildModels(next, config))
      const changed = nextFingerprint !== fingerprint
      catalog = next
      fingerprint = nextFingerprint
      if (disposed) return
      if (writtenFingerprint !== nextFingerprint) {
        if (await (dependencies.writeCache ?? writeCache)(next, path)) writtenFingerprint = nextFingerprint
        else if (!disposed) log("模型快取寫入失敗。")
      }
      if (!disposed && (reload || registered) && changed) await ctx.provider.reload()
    } catch {
      if (!disposed) log("模型更新失敗；保留目前的模型目錄。")
    } finally {
      fetching = false
    }
  }

  const cached = catalog !== null
  if (!cached) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      refresh(false),
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
  if (cached) void refresh(true)
  const schedule = dependencies.setInterval ?? setInterval
  const cancel = dependencies.clearInterval ?? clearInterval
  const timer = config.refreshIntervalMinutes > 0
    ? schedule(() => void refresh(true), Math.min(2_147_483_647, Math.floor(config.refreshIntervalMinutes * 60_000)))
    : undefined
  timer?.unref()

  return async () => {
    disposed = true
    controller?.abort()
    if (timer) cancel(timer)
    await authentication.dispose()
    await registration.dispose()
  }
}
