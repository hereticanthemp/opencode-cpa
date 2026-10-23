# opencode-cpa

將本機 CLIProxyAPI 的 Antigravity 模型接入 OpenCode v2 的 plugin。

## 狀態

WIP：已完成 CPA client、模型目錄與磁碟快取。plugin 尚未註冊 provider。

## 開發

使用 Node.js 24 與 npm。不需要 Bun。

```sh
npm install
npm run typecheck
npm run build
npm test
```

`build` 會先清除 `dist`，再輸出 JavaScript 與型別宣告。
測試使用 `node:test + tsx`，直接執行 TypeScript，不需要測試框架設定檔。

`package.json` 的入口指向 `dist/index.js`。
根目錄的 `server.js` 提供本機目錄載入入口。載入前須先執行建置。

## 模型目錄模組

- `parseConfig(options, env)`：options 優先於環境變數。無效型別略過該來源。負數更新間隔回到 10 分鐘。
- `fetchCatalog(config, { fetch })`：平行送出三個請求。一般 `/v1/models` 決定真實 id 與 `owned_by`；Anthropic 格式補名稱與 token 上限；Google 格式補 modalities。
- `buildProviderInfo(config)`、`buildModels(catalog, config)`：僅保留 `owned_by: antigravity`，一律使用 `@ai-sdk/google` 與 `/v1beta`。
- `catalogFingerprint(models)`：依模型 id 與物件欄位排序，再計算 SHA-256。轉換時也會排序並去除重複 modalities。
- `readCache(path?)`、`writeCache(catalog, path?)`：路徑可注入。讀取失敗回傳 `null`；寫入失敗回傳 `false`，由呼叫端決定通知方式。

設定支援 `baseURL`／`CPA_BASE_URL`、`apiKey`／`CPA_API_KEY`、`refreshIntervalMinutes`／`CPA_REFRESH_INTERVAL_MINUTES`。
`timeoutMs` 只接受 options，預設 10000。更新間隔預設 10 分鐘；0 表示停用。
網址會移除結尾斜線與 `/v1`、`/v1beta`。網址只接受 HTTP 或 HTTPS，不接受內嵌認證、query 或 fragment。

### 預設值與 modalities

模型以 `Model.Info.default` 為基底。缺少 token 上限時，沿用 context 200000、output 32000。
缺少 modalities 時只宣告 `text`，比 schema 的預設輸入 `text`、`image` 保守。
程式將 modalities 轉成小寫，只保留 `text`、`image`、`audio`、`video`、`pdf`。
未知詞彙不視為支援。空列表或全為未知詞彙時，使用 `text`。

詞彙依據為 OpenCode 原始碼：

- `packages/schema/src/model.ts`：`Model.Capabilities` 與 `Model.Info.default`。
- `packages/core/src/session/model-request.ts`：`mimeToModality` 使用 `image`、`audio`、`video`、`pdf`。
- `packages/app/src/runtime/server/global-sync/utils.ts`：介面檢查上述五種輸入與輸出詞彙。

一般 `/v1/models` 不帶 `anthropic-version`，只有此主來源失敗會讓整體失敗。
Anthropic 與 Google metadata 請求失敗時，使用對應欄位的預設值。
Anthropic metadata 配對前先解碼 cloaked id，保留 `model(value)` 的 thinking 後綴。
解碼對應 CPA `internal/client/claude/models/models.go` 的 `ResolveClaudeModelIDPrefix`。
停用 cloaking 時，非 cloaked id 保持不變。渠道只依一般模型列表的 `owned_by` 判斷。
Google modalities 依 `name` 移除 `models/` 後的真實 id 配對。
程式不使用顯示名稱推測配對，也不根據模型名稱選擇渠道。
測試保留實機 cloaked Anthropic fixture，另以手工建立的 uncloaked fixture 驗證停用 cloaking 的情況。

### 快取格式

快取路徑是 `$XDG_DATA_HOME/opencode-cpa/models.json`。
未設定 `XDG_DATA_HOME` 時，使用 `~/.local/share/opencode-cpa/models.json`。
快取格式是 `{ "version": 2, "catalog": { "models": [...] } }`。
版本 2 的模型 id 來自一般模型列表。版本 1 可能含 cloaked id，因此讀取時回傳 `null`。
只存正規化 CPA 中繼資料，不存 API key、provider settings 或 OpenCode 模型物件。
此格式不依賴 OpenCode schema，後續可用新版轉換邏輯重建模型。
寫入使用同目錄暫存檔與 rename；檔案權限為 `0600`。
