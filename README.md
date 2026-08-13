# PA!ZUA 商品智慧查價

手機拍商品或外盒，使用 Cloudflare Workers AI 讀取品牌 / 型號 / 包裝文字，再到 Cloudflare D1 商品資料庫比對價格。

## 第一版功能

- 手機直接開相機拍照搜尋
- 圖片在手機端先壓縮，降低等待時間
- AI 擷取品牌、型號、SKU、品名、包裝文字
- 型號 / SKU 優先比對，避免只靠「看起來很像」
- 顯示前 8 個最相近商品、售價、原價、商品圖片與原商品網址
- 文字搜尋
- GitHub Actions 每天自動爬 `https://pazua.easy.co` 並同步 D1
- 爬蟲優先讀 sitemap；沒有 sitemap 時，自動改爬首頁、分類與分頁
- 商品頁優先解析 JSON-LD / OpenGraph，因此比單純抓畫面文字穩定
- 同步成功後，已從來源網站消失的商品會標記為停用，不會混入搜尋結果

---

## 架構

```text
pazua.easy.co
    │
    │ GitHub Actions 每日爬商品
    ▼
Cloudflare Pages Function /api/sync
    │
    ▼
Cloudflare D1 商品資料庫
    ▲
    │
手機照片 → /api/vision → Workers AI → /api/search → 查價結果
```

---

## 你第一次部署只要做這 6 件事

### 1. 建 GitHub Repository

把這整個專案上傳到一個 Private Repository，例如：

`pazua-smart-price`

### 2. Cloudflare 建立 D1

Cloudflare → **Storage & databases → D1 SQL database → Create**

資料庫名稱：

`pazua-smart-price`

建立後進入 D1 Console，把 `schema.sql` 全部貼上並執行一次。

### 3. Cloudflare Pages 連 GitHub

Cloudflare → **Workers & Pages → Create → Pages → Connect to Git**

設定：

- Framework preset：None
- Build command：留白
- Build output directory：`public`
- Root directory：`/`

部署後會得到：

`https://你的專案.pages.dev`

### 4. 加入兩個 Bindings

Pages 專案 → **Settings → Bindings**

新增：

1. D1 database
   - Variable name：`DB`
   - Database：`pazua-smart-price`

2. Workers AI
   - Variable name：`AI`

新增後重新部署一次。

### 5. 設定同步密碼

Pages 專案 → **Settings → Variables and Secrets**

建立一個 Secret：

- Name：`SYNC_SECRET`
- Value：自己產生一串長密碼，例如 32~64 字元
- 選 Encrypt

這個值不要寫進程式碼。

### 6. GitHub 設定自動同步

Repository → **Settings → Secrets and variables → Actions → New repository secret**

建立：

- `SMART_PRICE_URL` = `https://你的專案.pages.dev`
- `SYNC_SECRET` = 跟 Cloudflare 完全相同的那串密碼

接著：

GitHub → **Actions → Sync EasyStore Products → Run workflow**

第一次手動跑完後，手機頁面上的「商品資料」就會出現數量。
之後系統會在**台灣時間每天 02:30**自動更新商品價格。

---

## Cloudflare AI 第一次使用

這個專案使用：

`@cf/meta/llama-4-scout-17b-16e-instruct`

它支援圖片理解。Pages 專案綁定 Workers AI 後即可由 `/api/vision` 使用。

如果 Cloudflare 帳號要求先接受 Meta 模型條款，請依 Cloudflare Dashboard / Workers AI 模型頁提示完成一次即可。

---

## 搜尋邏輯

系統不是單純「AI 猜商品」。優先順序如下：

1. 型號完全命中
2. SKU 完全命中
3. 品牌相符
4. 商品名稱相符
5. 包裝文字關鍵字相符

因此拍照時盡量把**品牌 + 型號**拍進去，準確度最高。

---

## 重要安全設定

`/api/sync` 只能使用 `Authorization: Bearer <SYNC_SECRET>` 寫入商品。

所以請務必：

- GitHub Repository 用 Private
- `SYNC_SECRET` 只放 Cloudflare Secret 與 GitHub Actions Secret
- 不要把密碼直接寫進 JS / README / GitHub 程式碼

---

## 檔案說明

```text
public/                    手機查價介面
functions/api/vision.js    AI 圖片辨識
functions/api/search.js    商品查詢與排序
functions/api/sync.js      爬蟲寫入 D1
scripts/crawl.mjs          EasyStore 商品爬蟲
schema.sql                 D1 資料表
.github/workflows/         每日自動同步
```

## 後續可以加的功能

- 商品條碼 / EAN / JAN 掃描
- 一次連續盤點 30~100 件
- 「這件已確認」紀錄
- 未辨識商品清單
- 商品圖片相似度向量搜尋
- 店內售價 / 進貨價 / 點數價多欄位
- 員工登入與查詢紀錄
