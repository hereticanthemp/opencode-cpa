import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { createImageTool } from "../src/image-tool.js"
import { parseConfig } from "../src/config.js"

async function fixture(t: TestContext, mime = "image/png") {
  const directory = await mkdtemp(join(process.cwd(), "test/.image-tool-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let calls = 0
  let body: any
  let models = ["a-image", "z-image"]
  let settings: { config: ReturnType<typeof parseConfig>; apiKey?: string } | undefined = { config: parseConfig({}, {}), apiKey: "private-key" }
  const tool = createImageTool({ directory, models: () => models, settings: async () => settings,
    fetch: async (_, init) => {
      calls++
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), settings?.apiKey ?? null)
      body = JSON.parse(String(init?.body))
      return Response.json({ candidates: [{ content: { parts: [{ text: "Model text" }, { inlineData: { mimeType: mime, data: Buffer.from("image bytes").toString("base64") } }] } }] })
    },
  })
  const controller = new AbortController()
  const context = { signal: controller.signal } as Parameters<typeof tool.execute>[1]
  return { directory, tool, controller, get calls() { return calls }, get body() { return body },
    set models(value: string[]) { models = value }, set settings(value: typeof settings) { settings = value },
    execute: (input: unknown) => tool.execute(input, context),
  }
}

test("tool 預設存檔、建立 gitignore，以 data URI 回傳且 metadata 沒有 key", async (t) => {
  const f = await fixture(t)
  const result = await f.execute({ prompt: "draw" })
  assert.match(result.metadata?.path, /^\.opencode\/cpa-images\/\d{8}-\d{6}-[a-f0-9]{4}\.png$/)
  assert.equal(await readFile(join(f.directory, result.metadata!.path), "utf8"), "image bytes")
  assert.equal(await readFile(join(f.directory, ".opencode/cpa-images/.gitignore"), "utf8"), "*\n")
  assert.deepEqual(result.metadata, { path: result.metadata!.path, model: "a-image", mime: "image/png", bytes: 11 })
  assert.doesNotMatch(JSON.stringify(result.metadata), /private-key|apiKey/)
  assert.ok(Array.isArray(result.content))
  assert.match(result.content[0].text, /git-ignored.*\nModel text$/)
  assert.deepEqual(result.content[1], { type: "file", uri: "data:image/png;base64,aW1hZ2UgYnl0ZXM=", mime: "image/png", name: result.metadata!.path.split("/").at(-1) })
  await writeFile(join(f.directory, ".opencode/cpa-images/.gitignore"), "existing\n")
  await f.execute({ prompt: "again" })
  assert.equal(await readFile(join(f.directory, ".opencode/cpa-images/.gitignore"), "utf8"), "existing\n")
})

test("tool 自訂路徑依 mime 補上或更換副檔名，不建立 gitignore，不覆寫", async (t) => {
  for (const [mime, ext] of [["image/jpeg", "jpg"], ["image/webp", "webp"], ["application/octet-stream", "bin"]]) {
    const f = await fixture(t, mime)
    for (const path of ["assets/output", "assets/other.png"]) {
      const result = await f.execute({ prompt: "draw", path })
      assert.equal(result.metadata?.path, `${path.replace(/\.png$/, "")}.${ext}`)
    }
    assert.deepEqual((await readdir(join(f.directory, "assets"))).sort(), [`other.${ext}`, `output.${ext}`])
    await assert.rejects(f.execute({ prompt: "draw", path: "assets/output" }), { message: "CPA image output already exists; choose a different path" })
    assert.equal(await readFile(join(f.directory, `assets/output.${ext}`), "utf8"), "image bytes")
  }
})

test("tool 參考圖片支援 PNG、JPEG、WebP 與大小寫副檔名", async (t) => {
  const f = await fixture(t)
  const names = ["a.PNG", "b.jpg", "c.jpeg", "d.webp"]
  for (const name of names) await writeFile(join(f.directory, name), "reference")
  await f.execute({ prompt: "edit", images: names, aspectRatio: "16:9", imageSize: "2K" })
  assert.deepEqual(f.body.contents[0].parts.slice(1).map((part: any) => part.inlineData),
    ["image/png", "image/jpeg", "image/jpeg", "image/webp"].map((mimeType) => ({ mimeType, data: Buffer.from("reference").toString("base64") })))
  assert.deepEqual(f.body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "2K" })
})

test("tool 自行驗證所有輸入欄位", async (t) => {
  const f = await fixture(t)
  for (const input of [null, [], {}, { prompt: " " }, { prompt: 1 }, { prompt: "x", extra: true },
    { prompt: "x", images: "a" }, { prompt: "x", images: [1] }, { prompt: "x", images: Array(9).fill("a.png") },
    { prompt: "x", aspectRatio: "bad" }, { prompt: "x", imageSize: "8K" }, { prompt: "x", path: 1 }]) {
    await assert.rejects(f.execute(input), (error: unknown) => error instanceof ToolError && error.message === "CPA image input is invalid")
  }
  assert.equal(f.calls, 0)
})

test("tool 拒絕絕對路徑、逃逸、.git 與 symlink 逃逸，包括不存在的輸出父目錄", async (t) => {
  const f = await fixture(t)
  const outside = await mkdtemp(join(process.cwd(), "test/.image-outside-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, "a.png"), "outside")
  await symlink(outside, join(f.directory, "escape"))
  await mkdir(join(f.directory, ".git"))
  await writeFile(join(f.directory, ".git/a.png"), "internal")
  await symlink(join(f.directory, ".git"), join(f.directory, "git-alias"))
  for (const path of ["/absolute.png", "../escape.png", "a/../../escape.png", ".git/a.png", "a/../.git/a.png", "git-alias/a.png", "escape/a.png", "escape/new/sub/file.png"]) {
    await assert.rejects(f.execute({ prompt: "x", path }), (error: unknown) => error instanceof ToolError)
    await assert.rejects(f.execute({ prompt: "x", images: [path] }), (error: unknown) => error instanceof ToolError)
  }
  assert.equal(f.calls, 0)
  assert.deepEqual(await readdir(outside), ["a.png"])
})

test("tool 拒絕未知輸入 mime 與總大小超過 20 MB", async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.directory, "a.gif"), "x")
  await assert.rejects(f.execute({ prompt: "x", images: ["a.gif"] }), { message: "CPA image inputs must be PNG, JPEG, or WebP" })
  for (const name of ["a.png", "b.png"]) {
    await writeFile(join(f.directory, name), "")
    await truncate(join(f.directory, name), 11 * 1024 * 1024)
  }
  await assert.rejects(f.execute({ prompt: "x", images: ["a.png", "b.png"] }), { message: "CPA image inputs exceed 20 MB" })
  assert.equal(f.calls, 0)
})

test("tool 選擇設定模型，拒絕不在清單的模型、無連線與中止", async (t) => {
  const f = await fixture(t)
  f.settings = { config: parseConfig({ imageModel: "z-image" }, {}) }
  assert.equal((await f.execute({ prompt: "x" })).metadata?.model, "z-image")
  f.models = ["a-image"]
  await assert.rejects(f.execute({ prompt: "x" }), { message: "CPA image model is unavailable" })
  f.settings = undefined
  await assert.rejects(f.execute({ prompt: "x" }), { message: "CPA image connection is unavailable" })
  f.controller.abort(new Error("private-key"))
  await assert.rejects(f.execute({ prompt: "x" }), { message: "CPA image request aborted" })
})

test("tool 允許工作目錄內的 symlink，但不覆寫輸出 symlink", async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.directory, "assets"))
  await writeFile(join(f.directory, "assets/input.png"), "original")
  await symlink(join(f.directory, "assets"), join(f.directory, "alias"))
  const result = await f.execute({ prompt: "edit", images: ["alias/input.png"], path: "alias/output.png" })
  assert.equal(result.metadata?.path, "alias/output.png")
  await symlink(join(f.directory, "assets/input.png"), join(f.directory, "existing.png"))
  await assert.rejects(f.execute({ prompt: "x", path: "existing.png" }), { message: "CPA image output already exists; choose a different path" })
  assert.equal(await readFile(join(f.directory, "assets/input.png"), "utf8"), "original")
})
