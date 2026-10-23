export interface Config {
  baseURL: string
  refreshIntervalMinutes: number
  timeoutMs: number
  imageModel?: string
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function normalizeBaseURL(value: unknown): string | undefined {
  const text = nonempty(value)
  if (!text) return
  try {
    const url = new URL(text)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return
    return url.toString().replace(/\/+$/, "").replace(/\/(v1|v1beta)$/, "")
  } catch {
    return
  }
}

/** 靜態設定不含 credential；每次 refresh 另外套用 active credential 的網址。 */
export function resolveConfig(config: Config, metadataURL: unknown): Config {
  if (metadataURL === undefined) return config
  const resolved = normalizeBaseURL(metadataURL)
  if (!resolved) throw new Error("CLIProxyAPI CPA URL is invalid.")
  return { ...config, baseURL: resolved }
}

function number(value: unknown, allowString = false): number | undefined {
  if (allowString && typeof value === "string" && value.trim()) value = Number(value)
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function parseConfig(
  options: Readonly<Record<string, unknown>> = {},
  env: NodeJS.ProcessEnv = process.env,
): Config {
  // 無效型別略過該來源；有效數字若超出範圍，直接使用預設值。
  const refresh = number(options.refreshIntervalMinutes) ?? number(env.CPA_REFRESH_INTERVAL_MINUTES, true) ?? 10
  const timeout = number(options.timeoutMs) ?? 10_000
  const imageModel = nonempty(options.imageModel) ?? nonempty(env.CPA_IMAGE_MODEL)
  return {
    baseURL: normalizeBaseURL(options.baseURL) ?? normalizeBaseURL(env.CPA_BASE_URL) ?? "http://127.0.0.1:8317",
    refreshIntervalMinutes: refresh === 0 || (refresh >= 1 / 60_000 && refresh <= 2_147_483_647 / 60_000) ? refresh : 10,
    timeoutMs: Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 2_147_483_647 ? timeout : 10_000,
    ...(imageModel ? { imageModel } : {}),
  }
}
