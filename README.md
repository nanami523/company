# 企業服務申請表單系統

基隆市銀髮人才服務據點 — 四項企業服務（企業入輔／聯合徵才／即時求才媒合／職場體驗）的線上申請表單，含後台管理（登入保護）。

## 這個系統長什麼樣子

- **前台**（所有企業都看得到）：`你的網址/`
  四項服務各自的表單，填寫 → 預覽 → 可返回修改 → 送出 → 顯示感謝頁與官方 LINE QR Code。
- **後台**（只有知道網址與密碼的管理者看得到）：`你的網址/admin-8x2kq9`
  需要輸入密碼才能看到所有企業送出的申請資料，可依服務類型、處理狀態篩選，並可標記已處理或刪除。

⚠️ **這套系統需要一台「會執行程式」的伺服器 + 一個資料庫，不能只用純靜態網站（例如 Render 的 Static Site 方案）部署** — 因為後台的登入驗證與資料儲存都需要伺服器端程式碼才能安全運作。請依照下方步驟，改用 Render 的 **Web Service** 方案。

---

## 部署步驟

### 第一步：申請免費資料庫（Neon Postgres）

1. 到 [neon.tech](https://neon.tech) 免費註冊帳號。
2. 建立一個新專案（Project），資料庫名稱隨意。
3. 在專案的 Dashboard 找到「Connection string」，複製那一長串（格式像 `postgres://user:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`），等下會用到。

### 第二步：把程式碼放到 GitHub

1. 在 GitHub 建立一個新的 repository（例如 `kcs-form-system`）。
2. 把這個資料夾裡的所有檔案上傳上去（`node_modules` 不用上傳，`.gitignore` 已經幫你排除了）。
3. **請把 `job-f.mp4`（小型徵才花絮）跟 `job-t.mp4`（職場體驗介紹）這兩支影片，放到 `public/` 資料夾裡，跟 `index.html` 同一層。** 網頁裡是用相對路徑 `job-f.mp4` / `job-t.mp4` 讀取影片，檔名跟位置都要完全一致才會正常播放。
   - GitHub 網頁介面上傳單一檔案有 25MB 限制，超過的話請改用 `git` 指令上傳，或先把影片壓縮小一點（建議控制在 20～30MB 以內，避免企業填表時載入太慢）。
   - 大型徵才活動的影片維持用 YouTube 內嵌（`https://youtu.be/7DBq5cwknso`），不需要另外上傳檔案。

### 第三步：在 Render 建立 Web Service

1. 到 [render.com](https://render.com) 登入，點選「New +」→「**Web Service**」（不是 Static Site）。
2. 選擇剛剛建立的 GitHub repository。
3. 設定：
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：選免費方案（Free）即可
4. 在「Environment」分頁，新增以下環境變數（可參考 `.env.example`）：

   | 變數名稱 | 說明 |
   |---|---|
   | `DATABASE_URL` | 第一步複製的 Neon 連線字串 |
   | `ADMIN_PATH` | 後台網址路徑，預設 `admin-8x2kq9`，也可以自訂 |
   | `ADMIN_INITIAL_PASSWORD` | 4 位管理者共用的初始密碼，**第一次啟動時**會自動寫入資料庫 |
   | `JWT_SECRET` | 隨便一長串英數亂碼即可（例如用密碼產生器產生 32 字元） |
   | `NOTIFY_EMAIL_TO` | 有新申請時要通知的信箱，例如 `kcs202355@gmail.com` |
   | `SMTP_USER` / `SMTP_PASS` | 選填，若要讓伺服器自動寄通知信，請填入 Gmail 帳號與「應用程式密碼」（見下方說明）。不填的話系統一樣會把資料存進後台，只是不會寄通知信 |

5. 點「Create Web Service」，等待部署完成。網址大概會長得像 `https://kcs-form-system.onrender.com`。

### 第四步：確認後台可以登入

打開 `https://你的網址.onrender.com/admin-8x2kq9`，輸入你在 `ADMIN_INITIAL_PASSWORD` 設定的密碼，應該就能看到後台畫面（一開始資料會是空的,等有人送出表單後就會出現）。

> 目前後台的「登入頁面」路徑是寫死在 `server.js` 裡的 `public/admin-8x2kq9` 資料夾。如果之後想把網址也一起改成別的隨機字串，把 `public/admin-8x2kq9` 資料夾改名，並同步修改 `server.js` 裡對應的路徑即可，或是直接告訴我要改成什麼，我可以幫你調整。

---

## 之後要怎麼修改密碼？

密碼是在**第一次啟動伺服器時**寫入資料庫的，之後改環境變數裡的 `ADMIN_INITIAL_PASSWORD` 不會再生效（這是為了避免密碼被意外重設）。要改密碼有兩種方式：

1. **請我幫忙改**：把新密碼告訴我，我可以幫你更新。
2. **自己在本機執行**：在專案資料夾建立一個 `.env` 檔（可以複製 `.env.example` 再填入你的 `DATABASE_URL`），然後執行：
   ```
   npm install
   node scripts/set-admin-password.js "你的新密碼"
   ```

---

## 關於 Email 通知（選填）

如果想要「有企業送出表單時，自動寄信通知」，需要設定 `SMTP_USER` 與 `SMTP_PASS`：

1. 使用一個 Gmail 帳號（建議另外申請一個給系統專用）。
2. 到 Google 帳號設定 →「安全性」→「兩步驟驗證」（需先開啟）→「應用程式密碼」，產生一組 16 碼的應用程式密碼。
3. 把 Gmail 帳號填入 `SMTP_USER`，剛剛產生的應用程式密碼填入 `SMTP_PASS`。

不設定的話系統完全正常運作，資料一樣會存進後台，只是不會主動寄信通知，需要自己去後台查看。

---

## 資料安全性說明

- 所有申請資料存在 Neon Postgres 資料庫，只有伺服器（透過 `DATABASE_URL`）能存取，一般人無法透過網址直接看到。
- 後台頁面（`/admin-8x2kq9`）即使被別人知道網址，沒有密碼還是進不去，因為讀取資料的 API 會檢查登入權杖（token）。
- 密碼在資料庫裡是加密（bcrypt 雜湊）儲存的，不會有人看得到明碼。
- 建議定期跟 4 位管理者確認密碼沒有外流；如需更換密碼請見上方說明。

## 本機測試（選填）

如果想先在自己電腦測試：

```bash
npm install
cp .env.example .env   # 編輯 .env，至少要填 DATABASE_URL
npm start
```

打開 `http://localhost:3000` 看前台，`http://localhost:3000/admin-8x2kq9` 看後台。
