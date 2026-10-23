import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isCatalog, normalizeModel, type CPACatalog } from "./cpa-client.js"

export function cachePath(env: NodeJS.ProcessEnv = process.env, home = homedir(), baseURL = "http://127.0.0.1:8317"): string {
  const source = createHash("sha256").update(baseURL).digest("hex").slice(0, 16)
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode-cpa", `models-${source}.json`)
}

export async function readCache(path = cachePath()): Promise<CPACatalog | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 4
      || !("catalog" in value) || !isCatalog(value.catalog)) return null
    return { models: value.catalog.models.map((model) => normalizeModel(model)!) }
  } catch {
    return null
  }
}

/** 失敗時傳回 false，並由呼叫端決定如何通知使用者。 */
export async function writeCache(catalog: CPACatalog, path = cachePath()): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    if (!isCatalog(catalog)) return false
    const clean = { models: catalog.models.map((model) => normalizeModel(model)!) }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, JSON.stringify({ version: 4, catalog: clean }), { flag: "wx", mode: 0o600 })
    await rename(temporary, path)
    return true
  } catch {
    return false
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
