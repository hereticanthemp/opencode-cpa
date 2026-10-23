import type { Config } from "./config.js"

/** 只修改送出前的 Request，不把認證放進公開模型或 session 資料。 */
export function authenticate(request: Request, config: Config): void {
  if (new URL(request.url).origin !== new URL(config.baseURL).origin) return
  request.headers.delete("x-goog-api-key")
  if (config.apiKey) request.headers.set("x-goog-api-key", config.apiKey)
}
