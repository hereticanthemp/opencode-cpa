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
- 在 OpenChamber／opencode 的 provider 連線畫面為 CLIProxyAPI 同時填入 API key 與 CPA URL。
- CPA 沒有設定 `api-keys` 時，key 欄位填任意非空字串。不要把 key 寫進 plugin options。
- 也可透過 `CPA_API_KEY` 與 `CPA_BASE_URL` 環境變數設定，不建立 credential。
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
          "package": "/path/to/opencode-cpa"
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

CPA URL 依下表選擇。credential 未提供網址時，才使用靜態設定：

| 優先順序 | 來源 |
| --- | --- |
| 1 | active credential 的 CPA URL（metadata `cpaBaseURL`） |
| 2 | plugin options 的 `baseURL` |
| 3 | 環境變數 `CPA_BASE_URL` |
| 4 | `http://127.0.0.1:8317` |

- CPA URL 是選填欄位，沒有 default。留空時不會存入 credential，也不會覆蓋 options。
- options 與環境變數的空字串或無效網址會略過。credential metadata 存在但網址無效（含空白）時，不退回其他網址。
- credential 網址無效時，plugin 顯示重新認證警告、記錄固定訊息，並保留目前目錄。本次不抓取模型。警告不會阻止推論，請先停止對話並修正 credential。
- 其他設定仍以 options 優先於環境變數。無效型別略過該來源，退回後續來源或預設值。
- `baseURL` 正規化：只接受 HTTP 或 HTTPS 網址。不接受內嵌認證、query 或 hash。程式會自動移除結尾斜線，並移除結尾的 `/v1` 或 `/v1beta`。
- `refreshIntervalMinutes`：環境變數支援字串轉數字。換算後必須介於 1 到 2,147,483,647 毫秒。超出範圍時退回預設值 10 分鐘。設為 0 表示停用定時更新。
- `timeoutMs`：無環境變數，只從 options 讀取。只接受 1 到 2,147,483,647 的安全正整數。超出範圍或型別無效時退回預設值 10000。
- 修改已儲存的 CPA URL 時，請重新新增 credential，填入 key 與新網址。OpenChamber 目前只支援修改 credential 標籤，不支援修改其網址。

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
- credential 是 opencode 全域資料。integration `cpa` 只有一組 active credential，所有專案共用 key 與該 credential 的 CPA URL。
- credential 沒有填 CPA URL 時，各專案可用 options 指向不同 CPA，但仍共用 active key。
- session 與 stateless generation 都由 opencode 的 Core 內建 Google provider 套用認證。推論 key 來自當下的 active credential，網址來自 plugin 發布的模型目錄。
- 在 UI 換成另一個 CPA 網址後，到 plugin reload 完成前（通常幾秒），請求可能以新 key 送到舊網址。建議換網址時先停止進行中的對話，等模型目錄更新後再繼續。
- 遠端 CPA 建議使用 HTTPS；若使用 HTTP，請只在可信任的內網使用。
- 每次更新模型列表前，plugin 都重新讀取 active connection 的 key 與網址。讀取失敗時保留目前來源與目錄，本次不抓取。
- 確認沒有 connection 時，模型列表改用靜態網址且不帶認證。
- 新增、啟用或移除 `cpa` 的 active credential 時，plugin 會更新模型列表。
- API key 不會進入公開模型資料、provider settings 或模型快取。
- 沒有 credential 時，opencode 會依 `activation: "enabled"` 使用 `Auth.none`，不套用 `GOOGLE_GENERATIVE_AI_API_KEY`。
- 請勿儲存空 key。plugin 偵測到空白 key 時，會在 connection 顯示重新認證警告，並記錄固定訊息。模型列表請求不帶認證。
- 上游限制：若已儲存的 key 是空字串，opencode v2.1.3 會退回 `GOOGLE_GENERATIVE_AI_API_KEY`，並把該 key 送到 CPA。UI 警告不能阻止此行為。
- 請使用有效的非空 key，或移除空 credential。也可取消設定 `GOOGLE_GENERATIVE_AI_API_KEY`，避免意外送出該 key。CPA 不需要 key 時，UI key 欄位填任意非空字串。

cache 機制：
- cache 位置為 `$XDG_DATA_HOME/opencode-cpa/models-<source>.json`。未設定環境變數時，目錄為 `~/.local/share/opencode-cpa`。
- `<source>` 是正規化 baseURL 的 SHA-256 前 16 碼。不同來源使用不同檔案，同來源的 instance 共用快取。
- 快取格式版本為 3。舊版 `models.json` 不再讀取。
- cache 只存正規化 CPA 中繼資料，不存 API key。
- CPA 離線時，plugin 會使用上次儲存的 cache。
- metadata 暫時失敗時，同 id 模型沿用已知名稱、token 上限與 modalities。新模型才使用預設值。
- 快取寫入失敗不阻擋模型更新。下次取得相同目錄時會重試寫入。
- 網址切換時，只讀取新網址的快取。新來源離線時仍使用新網址；沒有新快取時不註冊 provider，不沿用舊來源模型。

啟動與請求生命週期：
- 先讀取有效 CPA URL，再找對應快取。有快取時先註冊，並在背景更新。
- 無快取時最多等待 3 秒，且不超過 `timeoutMs`。此預算包含 connection 讀取。主來源成功後可先使用預設 metadata。
- metadata 超出啟動預算時，背景請求繼續補充資料。資料改變後會 reload provider。
- 讀取第一次 credential 前，先啟動事件訂閱。抓取期間收到 credential 切換事件時，中止舊請求並丟棄晚到結果，再補一次更新。
- 主來源在預算內失敗或未完成時，先註冊空 transform，再由定期更新或 credential 切換重試。更新間隔為 0 時，不會定期重試。
- 事件訂閱失敗時，以 1、2、4 秒遞增退避重試，上限 60 秒。重新訂閱後會補一次更新。事件串流正常結束時不重試。
- 主來源失敗時中止其他請求，等請求全部結束後才允許下次更新。cleanup 會中止請求與訂閱，並等待進行中的快取寫入完成。

provider 套件宣告：
- provider 與模型的 package 都是 `@opencode/ai/providers/google`，由 Core 載入內建實作。
- provider 與模型 settings 只存有效 CPA URL 加上 `/v1beta`，不存 apiKey。

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
