import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { cachePath, readCache, writeCache } from "../src/cache.js"
import type { CPACatalog } from "../src/cpa-client.js"

test("cache 路徑依 XDG_DATA_HOME 或 home 決定", () => {
  assert.equal(cachePath({ XDG_DATA_HOME: "/data" }, "/home/test"), "/data/opencode-cpa/models.json")
  assert.equal(cachePath({}, "/home/test"), "/home/test/.local/share/opencode-cpa/models.json")
})

test("cache 讀寫、覆寫、並行原子寫入，且只保留模型中繼資料", async () => {
  const directory = await mkdtemp(join(process.cwd(), "test/.cache-test-"))
  try {
    const path = join(directory, "nested/models.json")
    const catalog = { models: [{ id: "a", owned_by: "antigravity", input: ["text"] }], apiKey: "must-not-persist" }
    assert.equal(await readCache(path), null)
    assert.equal(await writeCache(catalog, path), true)
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2)
    assert.deepEqual(await readCache(path), { models: catalog.models })
    assert.doesNotMatch(await readFile(path, "utf8"), /must-not-persist|apiKey/)
    const next: CPACatalog = { models: [{ id: "b", max_tokens: 100 }] }
    assert.equal(await writeCache(next, path), true)
    assert.deepEqual(await readCache(path), next)
    assert.deepEqual(await Promise.all([writeCache(catalog, path), writeCache(next, path)]), [true, true])
    assert.ok(await readCache(path))
    assert.deepEqual(await readdir(join(directory, "nested")), ["models.json"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("cache 壞檔、錯誤版本與無效模型回 null；寫入失敗回 false", async () => {
  const directory = await mkdtemp(join(process.cwd(), "test/.cache-test-"))
  try {
    const path = join(directory, "models.json")
    for (const text of ["not json", "null", "{}", '{"version":3,"catalog":{"models":[]}}',
      '{"version":1,"catalog":{"models":[{"id":"claude-fable-5-dd-a","owned_by":"antigravity"}]}}',
      '{"version":2,"catalog":{"models":[{}]}}', '{"version":2,"catalog":{"models":[{"id":"a","max_tokens":-1}]}}',
      '{"version":2,"catalog":{"models":[{"id":"a","input":[42]}]}}']) {
      await writeFile(path, text)
      assert.equal(await readCache(path), null)
    }
    assert.equal(await readCache(directory), null)
    assert.equal(await writeCache({ models: [] }, directory), false)
    assert.equal(await writeCache({ models: [] }, join(path, "child.json")), false)
    assert.deepEqual((await readdir(directory)).sort(), ["models.json"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
