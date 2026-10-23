export interface Config {
  baseURL: string
  refreshIntervalMinutes: number
  timeoutMs: number
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function baseURL(value: unknown): string | undefined {
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
  return {
    baseURL: baseURL(options.baseURL) ?? baseURL(env.CPA_BASE_URL) ?? "http://127.0.0.1:8317",
    refreshIntervalMinutes: refresh === 0 || (refresh >= 1 / 60_000 && refresh <= 2_147_483_647 / 60_000) ? refresh : 10,
    timeoutMs: Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 2_147_483_647 ? timeout : 10_000,
  }
}
