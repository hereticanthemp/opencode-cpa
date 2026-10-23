import assert from "node:assert/strict"
import test from "node:test"
import { authenticate } from "../src/auth.js"
import { parseConfig } from "../src/config.js"

test("HTTP 認證覆寫最終 auth header，且只限 CPA origin", () => {
  const config = parseConfig({ apiKey: "private-key" }, {})
  const request = new Request(`${config.baseURL}/v1beta/models/a:streamGenerateContent`, { headers: { "x-goog-api-key": "cpa" } })
  authenticate(request, config)
  assert.equal(request.headers.get("x-goog-api-key"), "private-key")
  for (const url of ["https://example.com/v1beta", "http://127.0.0.1:8318/v1beta", "http://127.0.0.1.evil.test:8317"]) {
    const other = new Request(url)
    authenticate(other, config)
    assert.equal(other.headers.has("x-goog-api-key"), false)
  }
  authenticate(request, parseConfig({}, {}))
  assert.equal(request.headers.has("x-goog-api-key"), false)
})
