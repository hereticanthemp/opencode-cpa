# opencode-cpa

將本機 CLIProxyAPI 的 Antigravity 模型接入 OpenCode v2 的 plugin。

## 狀態

WIP：目前只有專案骨架，尚未註冊 provider 或抓取模型。

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
