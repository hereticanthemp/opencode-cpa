import type { Config } from "./config.js"
import { resolveClaudeModelIDPrefix } from "./claude-model-id.js"

export interface CPAModel {
  id: string
  owned_by?: string
  display_name?: string
  max_input_tokens?: number
  max_tokens?: number
  input?: string[]
  output?: string[]
}

export interface CPACatalog {
  models: CPAModel[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
}

function limit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 只保留模型中繼資料；不保留回應中的其他欄位或認證資料。 */
export function normalizeModel(value: unknown): CPAModel | undefined {
  if (!record(value) || typeof value.id !== "string" || !value.id.trim()) return
  return {
    id: value.id,
    ...(typeof value.owned_by === "string" ? { owned_by: value.owned_by } : {}),
    ...(typeof value.display_name === "string" && value.display_name.trim() ? { display_name: value.display_name } : {}),
    ...(limit(value.max_input_tokens) ? { max_input_tokens: limit(value.max_input_tokens) } : {}),
    ...(limit(value.max_tokens) ? { max_tokens: limit(value.max_tokens) } : {}),
    ...(strings(value.input) ? { input: strings(value.input) } : {}),
    ...(strings(value.output) ? { output: strings(value.output) } : {}),
  }
}

export function isCatalog(value: unknown): value is CPACatalog {
  return record(value) && Array.isArray(value.models) && value.models.every((item: unknown) => {
    if (!record(item) || !normalizeModel(item)) return false
    return ["owned_by", "display_name"].every((key) => item[key] === undefined || typeof item[key] === "string")
      && ["max_input_tokens", "max_tokens"].every((key) => item[key] === undefined || limit(item[key]) !== undefined)
      && ["input", "output"].every((key) => item[key] === undefined || strings(item[key]) !== undefined)
  })
}

export async function fetchCatalog(config: Config, dependencies: {
  apiKey?: string
  fetch?: typeof fetch
  signal?: AbortSignal
  previous?: CPACatalog | null
  onPrimary?: (catalog: CPACatalog) => void
} = {}): Promise<CPACatalog> {
  const request = dependencies.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs), ...(dependencies.signal ? [dependencies.signal] : [])])
  async function get(path: string, anthropic = false): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (dependencies.apiKey) headers.Authorization = `Bearer ${dependencies.apiKey}`
    if (anthropic) headers["anthropic-version"] = "2023-06-01"
    try {
      const response = await request(`${config.baseURL}${path}`, {
        headers,
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      // 不轉印遠端回應或 fetch 錯誤內容，避免認證資料出現在錯誤訊息。
      const reason = error instanceof Error && /^(HTTP \d+)$/.test(error.message)
        ? error.message
        : error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
          ? "請求逾時"
          : error instanceof SyntaxError ? "JSON 不合法" : "網路請求失敗"
      throw new Error(`CPA ${path}：${reason}`)
    }
  }

  const previous = new Map(dependencies.previous?.models.map((model) => [model.id, model]))
  const primary = get("/v1/models").then((value) => {
    if (!record(value) || !Array.isArray(value.data)) throw new Error("CPA /v1/models：缺少 data 模型列表")
    const models = value.data.map((item: unknown) => record(item) ? normalizeModel({ id: item.id, owned_by: item.owned_by }) : undefined)
      .filter((model): model is CPAModel => model !== undefined)
      .map((model) => ({ ...previous.get(model.id), ...model, owned_by: model.owned_by }))
    dependencies.onPrimary?.({ models })
    return models
  }).catch((error: unknown) => {
    controller.abort()
    throw error
  })
  const metadata = get("/v1/models", true).catch(() => undefined)
  const secondary = get("/v1beta/models").catch(() => undefined)
  const [main, meta, extra] = await Promise.allSettled([primary, metadata, secondary])
  if (main.status === "rejected") throw main.reason
  const models = main.value
  const anthropic = meta.status === "fulfilled" ? meta.value : undefined
  const google = extra.status === "fulfilled" ? extra.value : undefined
  const details = new Map<string, CPAModel>()
  if (record(anthropic) && Array.isArray(anthropic.data)) {
    for (const item of anthropic.data) {
      const model = normalizeModel(item)
      if (model) details.set(resolveClaudeModelIDPrefix(model.id), model)
    }
  }
  const modalities = new Map<string, Record<string, unknown>>()
  if (record(google) && Array.isArray(google.models)) {
    for (const item of google.models) {
      if (record(item) && typeof item.name === "string") modalities.set(item.name.replace(/^models\//, ""), item)
    }
  }
  return {
    models: models.map((model) => {
      const detail = details.get(model.id)
      const extra = modalities.get(model.id)
      const input = strings(extra?.supportedInputModalities)
      const output = strings(extra?.supportedOutputModalities)
      return {
        ...model,
        ...(detail?.display_name ? { display_name: detail.display_name } : {}),
        ...(detail?.max_input_tokens ? { max_input_tokens: detail.max_input_tokens } : {}),
        ...(detail?.max_tokens ? { max_tokens: detail.max_tokens } : {}),
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
      }
    }),
  }
}
