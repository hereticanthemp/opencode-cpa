import { createHash } from "node:crypto"
import { Integration, Model, Provider } from "@opencode/schema"
import type { Config } from "./config.js"
import type { CPACatalog } from "./cpa-client.js"

// ProviderEditor.add() 不會把 @ai-sdk/* 改寫成 OpenCode 內建套件，因此直接使用原生 specifier。
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

export function buildModels(catalog: CPACatalog, config: Config): Model.Info[] {
  return catalog.models.flatMap((model) => {
    const channel = model.owned_by && Object.hasOwn(channels, model.owned_by) ? channels[model.owned_by] : undefined
    if (!channel) return []
    const defaults = Model.Info.default(providerID, Model.ID.make(model.id))
    return [{
      ...defaults,
      name: model.display_name || model.id,
      package: channel.package,
      settings: { baseURL: `${config.baseURL}${channel.path}` },
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

export function catalogFingerprint(models: readonly Model.Info[]): string {
  return createHash("sha256").update(stable([...models].sort((a, b) => compare(a.id, b.id) || compare(stable(a), stable(b))))).digest("hex")
}
