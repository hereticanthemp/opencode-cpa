# opencode-cpa

讓 opencode v2 使用本機 CLIProxyAPI（CPA）的 Antigravity 模型的 plugin。

## 功能

- 從 CPA 動態抓取模型列表，並在啟動時與每 N 分鐘自動更新。
- 只註冊 `owned_by: antigravity` 的模型。
- 使用 Google Gemini 原生格式（`/v1beta/models/{id}:streamGenerateContent`），不用 OpenAI compatible。
- CPA 離線時使用上次的 cache。

## 需求

- opencode v2（已測 2.1.3）
- Node.js（建置用）
- 執行中的 CLIProxyAPI（已測 8.0.32）且有 antigravity 帳號

## 安裝

注意事項：
- 在 opencode／OpenChamber 的 provider 連線畫面為 CLIProxyAPI 輸入 API key，或設定環境變數 `CPA_API_KEY`。
- CPA 沒有設定 `api-keys` 時，不需要 API key。不要把 key 寫進 plugin options。
- 改程式後要重新 `npm run build`。

步驟：
1. 安裝相依套件：
   ```sh
   npm install
   ```
2. 建置專案：
   ```sh
   npm run build
   ```
3. 在 opencode 設定的 `plugins` 加入本機路徑：
   ```json
   {
     "plugins": [
       {
         "package": "/path/to/opencode-cpa",
         "options": { "baseURL": "http://127.0.0.1:8317" }
       }
     ]
   }
   ```

## 設定

| option 名稱 | 環境變數 | 預設值 | 說明 |
| --- | --- | --- | --- |
| `baseURL` | `CPA_BASE_URL` | `http://127.0.0.1:8317` | CPA 伺服器網址。 |
| `refreshIntervalMinutes` | `CPA_REFRESH_INTERVAL_MINUTES` | `10` | 模型列表更新間隔（分鐘）。`0` 停用。 |
| `timeoutMs` | （無） | `10000` | 網路請求逾時時間（毫秒）。 |

優先順序與正規化規則：

- 優先順序：options 優先於環境變數。無效型別略過該來源，退回後續來源或預設值。
- `baseURL` 正規化：只接受 HTTP 或 HTTPS 網址。不接受內嵌認證、query 或 hash。程式會自動移除結尾斜線，並移除結尾的 `/v1` 或 `/v1beta`。
- `refreshIntervalMinutes`：環境變數支援字串轉數字。換算後必須介於 1 到 2,147,483,647 毫秒。超出範圍時退回預設值 10 分鐘。設為 0 表示停用定時更新。
- `timeoutMs`：無環境變數，只從 options 讀取。只接受 1 到 2,147,483,647 的安全正整數。超出範圍或型別無效時退回預設值 10000。

## 使用

模型 id 格式為 `cpa/<model>`。例如：

```sh
opencode run -m cpa/gemini-3-flash "..."
```

## 運作方式

CPA 端點用途：
- 一般 `/v1/models`：主來源。決定真實模型 id 與 `owned_by` 渠道。此請求不帶 `anthropic-version` 標頭；只有此主來源失敗會讓整體流程失敗。
- Anthropic 格式 `/v1/models`：請求帶 `anthropic-version` 標頭。補充模型名稱與 token 上限，並解碼 CPA 的 `claude-fable-5-dd-` cloaking。
- Google 格式 `/v1beta/models`：補充模型的 modalities（輸入與輸出支援能力）。

認證：
- plugin 註冊 `cpa` integration，名稱為 CLIProxyAPI。支援 API key 與 `CPA_API_KEY` 環境變數。
- opencode credential 機制負責保存與套用 key。已儲存的 credential 優先於環境變數。
- credential 是 opencode 全域資料。integration `cpa` 只有一組 active key，所有專案共用。
- 不同專案即使指向不同 CPA，也會使用同一組 active key。
- session 與 stateless generation 都由 opencode 在執行時套用認證。
- 每次更新模型列表前，plugin 都重新讀取 active connection。讀取失敗或沒有 key 時，不帶認證。
- 新增、啟用或移除 `cpa` 的 active credential 時，plugin 會更新模型列表。
- API key 不會進入公開模型資料、provider settings 或模型快取。
- 沒有 CPA credential 時，opencode 不會套用 `GOOGLE_GENERATIVE_AI_API_KEY`。
- 請勿儲存空 key。plugin 偵測到空白 key 時，會在 connection 顯示重新認證警告，並記錄固定訊息。模型列表請求不帶認證。
- opencode v2.1.3 對「存在但 key 為空字串」的 credential 仍可能退回 `GOOGLE_GENERATIVE_AI_API_KEY`。此上游限制也影響 stateless generation。
- UI 警告不能阻止上述 fallback。請輸入有效 key；CPA 不需要 key 時，請移除空 credential，而非儲存空字串。

cache 機制：
- cache 位置為 `$XDG_DATA_HOME/opencode-cpa/models-<source>.json`。未設定環境變數時，目錄為 `~/.local/share/opencode-cpa`。
- `<source>` 是正規化 baseURL 的 SHA-256 前 16 碼。不同來源使用不同檔案，同來源的 instance 共用快取。
- 快取格式版本為 3。舊版 `models.json` 不再讀取。
- cache 只存正規化 CPA 中繼資料，不存 API key。
- CPA 離線時，plugin 會使用上次儲存的 cache。
- metadata 暫時失敗時，同 id 模型沿用已知名稱、token 上限與 modalities。新模型才使用預設值。
- 快取寫入失敗不阻擋模型更新。下次取得相同目錄時會重試寫入。

啟動與請求生命週期：
- 有快取時立即註冊，並在背景更新。
- 無快取時最多等待 3 秒，且不超過 `timeoutMs`。此預算包含 connection 讀取。主來源成功後可先使用預設 metadata。
- metadata 超出啟動預算時，背景請求繼續補充資料。資料改變後會 reload provider。
- 讀取第一次 credential 前，先啟動事件訂閱。抓取期間收到 credential 切換事件時，完成後會補一次更新。
- 主來源在預算內失敗或未完成時，先註冊空 transform，再由定期更新或 credential 切換重試。更新間隔為 0 時，不會定期重試。
- 事件訂閱失敗時，以 1、2、4 秒遞增退避重試，上限 60 秒。重新訂閱後會補一次更新。事件串流正常結束時不重試。
- 主來源失敗時中止其他請求，等請求全部結束後才允許下次更新。cleanup 會中止請求與訂閱，並等待進行中的快取寫入完成。

provider 套件宣告：
- plugin 宣告的 package 為 `@opencode/ai/providers/google`。
- opencode 的 `ProviderEditor.add()` 不改寫 `@ai-sdk/*`，因此不能直接寫 `@ai-sdk/google`。

## 限制

- 只支援 antigravity 渠道。
- 不顯示剩餘額度。
- 沒有提供 thinking variants。
- 未發布到 npm。

## 開發

```sh
npm run typecheck
npm test
npm run build
```
