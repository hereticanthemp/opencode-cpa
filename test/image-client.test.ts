import assert from "node:assert/strict"
import test from "node:test"
import { generateImage } from "../src/image-client.js"
import { parseConfig } from "../src/config.js"

const config = parseConfig({}, {})
const request = { model: "model/with space", prompt: "draw" }
const image = { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }

test("image client 送出原生 URL、key、參考圖片與 imageConfig，略過 thought 並取最後圖片", async () => {
  const result = await generateImage(config, { ...request, images: [{ mime: "image/jpeg", data: "ref" }], aspectRatio: "16:9", imageSize: "2K" }, {
    apiKey: "private-key",
    fetch: async (url, init) => {
      assert.equal(url, `${config.baseURL}/v1beta/models/model%2Fwith%20space:generateContent`)
      assert.equal(init?.method, "POST")
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "private-key")
      assert.deepEqual(JSON.parse(String(init?.body)), {
        contents: [{ role: "user", parts: [{ text: "draw" }, { inlineData: { mimeType: "image/jpeg", data: "ref" } }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" } },
      })
      return Response.json({ candidates: [{ content: { parts: [
        { text: "secret thought", thought: true }, { text: "  final " },
        { inlineData: { mimeType: "image/jpeg", data: "old" } }, image,
        { ...image, inlineData: { mimeType: "image/webp", data: "thought" }, thought: true }, { text: "text  " },
      ] } }, { content: { parts: [{ text: "ignored" }] } }] })
    },
  })
  assert.deepEqual(result, { mime: "image/png", data: "aGVsbG8=", text: "final text" })
})

test("image client 省略未設定的 key、imageConfig 與空文字", async () => {
  const result = await generateImage(config, request, { fetch: async (_, init) => {
    assert.equal(new Headers(init?.headers).has("x-goog-api-key"), false)
    assert.deepEqual(JSON.parse(String(init?.body)).generationConfig, { responseModalities: ["TEXT", "IMAGE"] })
    return Response.json({ candidates: [{ content: { parts: [{ text: " " }, image] } }] })
  } })
  assert.deepEqual(result, { mime: "image/png", data: "aGVsbG8=" })
})

test("image client 固定 HTTP、JSON 與網路錯誤，不洩漏 key 或 body", async () => {
  for (const [fetch, message] of [
    [async () => new Response("private-key remote-body", { status: 400 }), "CPA image request failed: HTTP 400"],
    [async () => new Response("private-key invalid json"), "CPA image response is not valid JSON"],
    [async () => { throw new Error("private-key fetch details") }, "CPA image request failed: network error"],
  ] as const) {
    await assert.rejects(generateImage(config, request, { apiKey: "private-key", fetch }), { message })
  }
})

test("image client 沒有圖片時附 finishReason 與最多 500 字元的非 thought 文字", async () => {
  await assert.rejects(generateImage(config, request, { fetch: async () => Response.json({ candidates: [{
    finishReason: "SAFETY", content: { parts: [{ text: "hidden", thought: true }, { ...image, thought: true }, { text: "x".repeat(600) }] },
  }] }) }), { message: `CPA image response contains no image (SAFETY): ${"x".repeat(500)}` })
  for (const value of [null, {}, { candidates: [] }, { candidates: [{ content: { parts: [null, {}] } }] }]) {
    await assert.rejects(generateImage(config, request, { fetch: async () => Response.json(value) }), { message: "CPA image response contains no image" })
  }
  await assert.rejects(generateImage(config, request, { apiKey: "private-key", fetch: async () => Response.json({ candidates: [{ content: { parts: [{ text: "private-key" }] } }] }) }),
    { message: "CPA image response contains no image: [redacted]" })
})

test("image client 逾時與外部中止可區分，傳入 fetch signal", async () => {
  let signal: AbortSignal | null | undefined
  const fetch: typeof globalThis.fetch = async (_, init) => {
    signal = init?.signal
    return new Promise(() => {})
  }
  await assert.rejects(generateImage(config, request, { fetch, timeoutMs: 5 }), { message: "CPA image request timed out" })
  assert.equal(signal?.aborted, true)
  const controller = new AbortController()
  const pending = generateImage(config, request, { fetch, signal: controller.signal })
  controller.abort(new Error("private-key"))
  await assert.rejects(pending, { name: "AbortError", message: "CPA image request aborted" })
  assert.equal(signal?.aborted, true)
  await assert.rejects(generateImage(config, request, { fetch: async () => assert.fail("不得送出已中止請求"), signal: controller.signal }), { name: "AbortError" })
})

test("image client 等待回應 body 時仍受逾時與外部 signal 限制", async () => {
  for (const external of [false, true]) {
    const controller = new AbortController()
    const pending = generateImage(config, request, {
      signal: controller.signal, timeoutMs: external ? 120_000 : 5,
      fetch: async () => new Response(new ReadableStream({ start() {
        if (external) queueMicrotask(() => controller.abort())
      } })),
    })
    await assert.rejects(pending, external ? { name: "AbortError" } : { message: "CPA image request timed out" })
  }
})

test("image client 正規化輸出 mime，只接受 PNG、JPEG、WebP", async () => {
  for (const mime of [" IMAGE/PNG ; charset=binary ", "Image/JPEG", " image/webp "]) {
    const result = await generateImage(config, request, { fetch: async () => Response.json({ candidates: [{ content: { parts: [
      { inlineData: { mimeType: mime, data: image.inlineData.data } },
    ] } }] }) })
    assert.equal(result.mime, mime.split(";", 1)[0].trim().toLowerCase())
  }
  for (const mime of ["image/gif", "image/svg+xml", "application/octet-stream", "private-key", "", "  ", undefined, 1]) {
    await assert.rejects(generateImage(config, request, { apiKey: "private-key", fetch: async () => Response.json({ candidates: [{ content: { parts: [
      { inlineData: { mimeType: mime, data: image.inlineData.data } },
    ] } }] }) }), { message: "CPA image response has an unsupported image type" })
  }
})

test("image client 驗證標準 base64 字元、長度與結尾 padding", async () => {
  const generate = (data: unknown) => generateImage(config, request, { apiKey: "private-key", fetch: async () => Response.json({ candidates: [{ content: { parts: [
    { inlineData: { mimeType: "image/png", data } },
  ] } }] }) })
  for (const data of ["AA==", "AAA=", "AAAA", "+/8="]) assert.equal((await generate(data)).data, data)
  for (const data of ["", undefined, 1, "AAA", "AAAAA", "A===", "AA=A", "=AAA", "AA-_", "AA\n=", "AA =", "AAA\n", "AAAA\n", "private-key"]) {
    await assert.rejects(generate(data), { message: "CPA image response has invalid base64 data" })
  }
})

test("image client 輸出大小接受 32 MB 邊界，拒絕超過上限", async () => {
  const maximum = 32 * 1024 * 1024
  const generate = (bytes: number) => {
    const padding = bytes % 3 === 1 ? "==" : bytes % 3 === 2 ? "=" : ""
    const data = "A".repeat(Math.ceil(bytes / 3) * 4 - padding.length) + padding
    return generateImage(config, request, { fetch: async () => Response.json({ candidates: [{ content: { parts: [
      { inlineData: { mimeType: "image/png", data } },
    ] } }] }) })
  }
  for (const bytes of [maximum - 1, maximum]) {
    const result = await generate(bytes)
    assert.equal(Buffer.byteLength(result.data, "base64"), bytes)
  }
  await assert.rejects(generate(maximum + 1), { message: "CPA image response exceeds 32 MB" })
})

test("image client 只回傳合法 finishReason，保留拒絕文字上限與 key redact", async () => {
  for (const finishReason of ["STOP", "A".repeat(64), "", "A".repeat(65), "stop", "STOP_1", "STOP\n", "private-key"]) {
    const valid = /^[A-Z_]{1,64}$/.exec(finishReason)?.[0] === finishReason
    await assert.rejects(generateImage(config, request, { apiKey: "private-key", fetch: async () => Response.json({ candidates: [{
      finishReason, content: { parts: [{ text: `private-key${"x".repeat(600)}` }] },
    }] }) }), { message: `CPA image response contains no image${valid ? ` (${finishReason})` : ""}: ${`[redacted]${"x".repeat(600)}`.slice(0, 500)}` })
  }
})
