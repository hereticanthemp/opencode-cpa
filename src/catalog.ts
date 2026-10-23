import { createHash } from "node:crypto"
import { Integration, Model, Provider } from "@opencode/schema"
import type { Config } from "./config.js"
import type { CPACatalog } from "./cpa-client.js"

// ProviderEditor.add() 不會把 @ai-sdk/* 改寫成 OpenCode 內建套件，因此直接使用原生 specifier。
// 不用 plugin 自帶的 provider 模組：跨套件的 AIError 會讓 Core 的 instanceof 判斷失效，串流錯誤無法自動重試。
export const channels: Readonly<Record<string, { package: string; path: string }>> = {
  antigravity: { package: "@opencode/ai/providers/google", path: "/v1beta" },
}
const providerID = Provider.ID.make("cpa")

export function buildProviderInfo(config: Config): Provider.Info {
  return {
    id: providerID,
    integrationID: Integration.ID.make("cpa"),
    name: "CLIProxyAPI",
    activation: "enabled",
    package: channels.antigravity.package,
    settings: {
      baseURL: `${config.baseURL}${channels.antigravity.path}`,
    },
  }
}

// OpenCode 的 capability 使用小寫詞彙，不將未知 modality 宣告為支援。
function modalities(values: string[] | undefined): string[] {
  const known = new Set(["text", "image", "audio", "video", "pdf"])
  const result = [...new Set((values ?? []).map((value) => value.toLowerCase()).filter((value) => known.has(value)))].sort()
  return result.length ? result : ["text"]
}

function variants(model: CPACatalog["models"][number]): Model.Info["variants"] {
  const levels = model.reasoning_levels
  if (!levels) return []
  const native = ["minimal", "low", "medium", "high"]
  // Codex 沒有來源旗標；拒絕非 Gemini 等級與不符合 CPA thinking 預設規則的模板資料。
  if (levels.some((level) => level !== "none" && !native.includes(level))) return []
  if (levels.includes("medium") && model.default_reasoning_level !== "medium") return []
  // CPA 對明確的空 levels 清單使用 budget 路徑；讓 CPA 自行轉換與限制 budget。
  const selected = levels.length === 0 ? ["low", "medium", "high"] : native.filter((level) => levels.includes(level))
  return selected.map((level) => ({ id: Model.VariantID.make(level), settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: level } } }))
}

export function buildModels(catalog: CPACatalog, config: Config): Model.Info[] {
  return catalog.models.flatMap((model) => {
    const channel = model.owned_by && Object.hasOwn(channels, model.owned_by) ? channels[model.owned_by] : undefined
    if (!channel) return []
    const defaults = Model.Info.default(providerID, Model.ID.make(model.id))
    return [{
      ...defaults,
      name: model.display_name || model.id,
      package: channel.package,
      settings: { baseURL: `${config.baseURL}${channel.path}`, thinkingConfig: { includeThoughts: true } },
      variants: variants(model),
      limit: {
        context: model.max_input_tokens ?? defaults.limit.context,
        output: model.max_tokens ?? defaults.limit.output,
      },
      capabilities: { tools: true, input: modalities(model.input), output: modalities(model.output) },
    }]
  }).sort((a, b) => compare(a.id, b.id) || compare(stable(a), stable(b)))
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function catalogFingerprint(models: readonly { readonly id: string }[]): string {
  return createHash("sha256").update(stable([...models].sort((a, b) => compare(a.id, b.id) || compare(stable(a), stable(b))))).digest("hex")
}
