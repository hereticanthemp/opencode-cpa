import type { Config } from "./config.js"

export interface ImageRequest {
  model: string
  prompt: string
  images?: { mime: string; data: string }[]
  aspectRatio?: string
  imageSize?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function generateImage(config: Config, request: ImageRequest, dependencies: {
  apiKey?: string
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<{ mime: string; data: string; text?: string }> {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, ...(dependencies.signal ? [dependencies.signal] : [])])
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 120_000)
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(dependencies.signal?.aborted
      ? new DOMException("CPA image request aborted", "AbortError") : new Error("CPA image request timed out"))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
  const run = async () => {
    signal.throwIfAborted()
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (dependencies.apiKey) headers["x-goog-api-key"] = dependencies.apiKey
    const imageConfig = { ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.imageSize ? { imageSize: request.imageSize } : {}) }
    let response: Response
    try {
      response = await (dependencies.fetch ?? globalThis.fetch)(`${config.baseURL}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`, {
        method: "POST", headers, signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: request.prompt }, ...(request.images ?? []).map((image) => ({ inlineData: { mimeType: image.mime, data: image.data } }))] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
        }),
      })
    } catch {
      throw new Error("CPA image request failed: network error")
    }
    if (!response.ok) throw new Error(`CPA image request failed: HTTP ${response.status}`)
    let value: unknown
    try { value = await response.json() } catch { throw new Error("CPA image response is not valid JSON") }
    const candidate = record(value) && Array.isArray(value.candidates) ? value.candidates[0] : undefined
    const content = record(candidate) && record(candidate.content) ? candidate.content : undefined
    const parts = content && Array.isArray(content.parts) ? content.parts.filter((part: unknown) => record(part) && part.thought !== true) : []
    const text = parts.flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("").trim()
    const image = parts.map((part) => part.inlineData).filter((data: unknown) => record(data)
      && typeof data.mimeType === "string" && data.mimeType && typeof data.data === "string" && data.data).at(-1)
    if (!image) {
      const redact = (value: string) => dependencies.apiKey ? value.replaceAll(dependencies.apiKey, "[redacted]") : value
      const finish = record(candidate) && typeof candidate.finishReason === "string" ? ` (${redact(candidate.finishReason)})` : ""
      throw new Error(`CPA image response contains no image${finish}${text ? `: ${redact(text).slice(0, 500)}` : ""}`)
    }
    return { mime: image.mimeType as string, data: image.data as string, ...(text ? { text } : {}) }
  }
  try {
    return await Promise.race([cancelled, run()])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}
