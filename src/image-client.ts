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
    const image = parts.map((part) => part.inlineData).filter(record).at(-1)
    if (!image) {
      const redact = (value: string) => dependencies.apiKey ? value.replaceAll(dependencies.apiKey, "[redacted]") : value
      const finish = record(candidate) && typeof candidate.finishReason === "string" && /^[A-Z_]{1,64}$/.exec(candidate.finishReason)?.[0] === candidate.finishReason
        ? ` (${redact(candidate.finishReason)})` : ""
      throw new Error(`CPA image response contains no image${finish}${text ? `: ${redact(text).slice(0, 500)}` : ""}`)
    }
    const mime = typeof image.mimeType === "string" ? image.mimeType.split(";", 1)[0].trim().toLowerCase() : ""
    if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new Error("CPA image response has an unsupported image type")
    const data = image.data
    if (typeof data !== "string" || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new Error("CPA image response has invalid base64 data")
    }
    const bytes = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
    if (bytes > 32 * 1024 * 1024) throw new Error("CPA image response exceeds 32 MB")
    return { mime, data, ...(text ? { text } : {}) }
  }
  try {
    return await Promise.race([cancelled, run()])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}
