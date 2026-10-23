import type { Plugin } from "@opencode/plugin"
import { cachePath, readCache, writeCache } from "./cache.js"
import { buildModels, buildProviderInfo, catalogFingerprint } from "./catalog.js"
import { parseConfig, type Config } from "./config.js"
import { fetchCatalog, type CPACatalog } from "./cpa-client.js"

type Context = Pick<Plugin.Context, "options" | "provider">
interface Dependencies {
  env?: NodeJS.ProcessEnv
  cachePath?: string
  fetch?: typeof fetch
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  log?: (message: string) => void
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

  const path = dependencies.cachePath ?? cachePath(env)
  let catalog: CPACatalog | null = await readCache(path)
  let fingerprint = catalogFingerprint(catalog ? buildModels(catalog, config) : [])
  let disposed = false
  let fetching = false

  async function refresh(reload: boolean): Promise<void> {
    if (disposed || fetching) return
    fetching = true
    try {
      const next = await fetchCatalog(config, { fetch: dependencies.fetch })
      if (disposed) return
      const nextFingerprint = catalogFingerprint(buildModels(next, config))
      if (catalog !== null && nextFingerprint === fingerprint) return
      if (!await writeCache(next, path) && !disposed) log("模型快取寫入失敗。")
      if (disposed) return
      const changed = nextFingerprint !== fingerprint
      catalog = next
      fingerprint = nextFingerprint
      if (reload && changed) await ctx.provider.reload()
    } catch {
      if (!disposed) log("模型更新失敗；保留目前的模型目錄。")
    } finally {
      fetching = false
    }
  }

  const cached = catalog !== null
  if (!cached) await refresh(false)
  const registration = await ctx.provider.transform((editor) => {
    if (disposed || !catalog) return
    const models = buildModels(catalog, config)
    if (models.length) editor.add({ info: buildProviderInfo(config), models })
  })
  if (cached) void refresh(true)
  const schedule = dependencies.setInterval ?? setInterval
  const cancel = dependencies.clearInterval ?? clearInterval
  const timer = config.refreshIntervalMinutes > 0
    ? schedule(() => void refresh(true), config.refreshIntervalMinutes * 60_000)
    : undefined
  timer?.unref()

  return async () => {
    disposed = true
    if (timer) cancel(timer)
    await registration.dispose()
  }
}
