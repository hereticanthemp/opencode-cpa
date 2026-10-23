import assert from "node:assert/strict"
import test from "node:test"
import { parseConfig, resolveConfig } from "../src/config.js"

test("config 使用預設值，且 API key 可省略", () => {
  assert.deepEqual(parseConfig({}, {}), {
    baseURL: "http://127.0.0.1:8317", refreshIntervalMinutes: 10, timeoutMs: 10_000,
  })
})

test("config 優先使用 options，再使用環境變數", () => {
  const env = { CPA_BASE_URL: "http://env:1234/v1/", CPA_API_KEY: "env-key", CPA_REFRESH_INTERVAL_MINUTES: "20" }
  assert.deepEqual(parseConfig({}, env), {
    baseURL: "http://env:1234", refreshIntervalMinutes: 20, timeoutMs: 10_000,
  })
  assert.deepEqual(parseConfig({ baseURL: "http://option:1234/v1beta///", apiKey: "option-key", refreshIntervalMinutes: 0, timeoutMs: 500 }, env), {
    baseURL: "http://option:1234", refreshIntervalMinutes: 0, timeoutMs: 500,
  })
})

test("config 驗證 options 型別並正規化根網址", () => {
  for (const suffix of ["", "/", "/v1", "/v1/", "/v1beta", "/v1beta///"]) {
    assert.equal(parseConfig({ baseURL: `http://localhost:8317${suffix}` }, {}).baseURL, "http://localhost:8317")
  }
  assert.equal(parseConfig({ baseURL: "http://localhost/proxy/v1" }, {}).baseURL, "http://localhost/proxy")
  const config = parseConfig({ baseURL: 42, apiKey: false, refreshIntervalMinutes: [], timeoutMs: "500" }, {
    CPA_BASE_URL: "https://env/v1", CPA_API_KEY: "env-key", CPA_REFRESH_INTERVAL_MINUTES: "3.5",
  })
  assert.equal(config.baseURL, "https://env")
  assert.equal("apiKey" in config, false)
  assert.equal(config.refreshIntervalMinutes, 3.5)
  assert.equal(config.timeoutMs, 10_000)
})

test("config 拒絕無效網址、負數、非數字與無效 timeout", () => {
  for (const value of ["bad-url", "file:///test", "http://user:password@host", "http://host/?key=secret", "http://host/#secret"]) {
    assert.equal(parseConfig({ baseURL: value }, {}).baseURL, "http://127.0.0.1:8317")
  }
  for (const value of [-1, NaN, Infinity, "abc", null, true]) {
    assert.equal(parseConfig({ refreshIntervalMinutes: value }, {}).refreshIntervalMinutes, 10)
  }
  for (const value of ["-1", "abc", "", "Infinity"]) {
    assert.equal(parseConfig({}, { CPA_REFRESH_INTERVAL_MINUTES: value }).refreshIntervalMinutes, 10)
  }
  for (const value of [0, -1, 0.5, Infinity, 4_294_967_296]) {
    assert.equal(parseConfig({ timeoutMs: value }, {}).timeoutMs, 10_000)
  }
})

test("timer 毫秒值限制在 1 到 signed 32-bit 最大值，0 只停用 interval", () => {
  const maximum = 2_147_483_647
  assert.equal(parseConfig({ timeoutMs: maximum }, {}).timeoutMs, maximum)
  assert.equal(parseConfig({ timeoutMs: maximum + 1 }, {}).timeoutMs, 10_000)
  assert.equal(parseConfig({ refreshIntervalMinutes: maximum / 60_000 }, {}).refreshIntervalMinutes, maximum / 60_000)
  assert.equal(parseConfig({ refreshIntervalMinutes: (maximum + 1) / 60_000 }, {}).refreshIntervalMinutes, 10)
  assert.equal(parseConfig({ refreshIntervalMinutes: 0.5 / 60_000 }, {}).refreshIntervalMinutes, 10)
  assert.equal(parseConfig({ refreshIntervalMinutes: 0 }, {}).refreshIntervalMinutes, 0)
  assert.equal(parseConfig({ baseURL: "HTTP://LOCALHOST:80/v1/" }, {}).baseURL, "http://localhost")
})

test("CPA URL 優先使用 credential metadata，再使用 options、環境變數與預設值", () => {
  const env = { CPA_BASE_URL: "https://env.example/v1" }
  const options = { baseURL: "https://option.example/v1beta" }
  const config = parseConfig(options, env)
  assert.equal(resolveConfig(config, " https://credential.example/v1beta/// ").baseURL, "https://credential.example")
  assert.equal(resolveConfig(config, undefined).baseURL, "https://option.example")
  assert.equal(resolveConfig(parseConfig({}, env), undefined).baseURL, "https://env.example")
  assert.equal(resolveConfig(parseConfig({}, {}), undefined).baseURL, "http://127.0.0.1:8317")
  assert.equal(config.baseURL, "https://option.example", "不得修改靜態設定")
})

test("metadata 未提供時沿用靜態設定，存在但無效時丟錯且不轉印設定值", () => {
  const config = parseConfig({ baseURL: "https://option.example" }, {})
  assert.equal(resolveConfig(config, undefined), config)
  for (const value of ["", " \t ", null, 42, [], "bad", "file:///test", "http://user:password@host", "http://host/?key=secret", "http://host/#secret"]) {
    assert.throws(() => resolveConfig(config, value), { message: "CLIProxyAPI CPA URL is invalid." })
  }
})
