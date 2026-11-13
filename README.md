# Tello EDU 電腦版地面站

用 **Xbox 手把＋電腦瀏覽器** 控制 Ryze Tello / Tello EDU，不需要官方 App。
深色駕駛艙介面、HUD、人工地平線、飛前檢查、斷訊自動懸停／降落，全部離線運作。

```
Xbox 手把 ──USB──> Chrome / Edge（Gamepad API，http://localhost:8080）
                      │  /ws/control  rc 30 Hz ↑ ／ 遙測 10 Hz、指令結果 ↓
                      │  /ws/video    H.264 → WebCodecs → canvas（低延遲，不轉檔）
                      │  /video.mjpg  備援：ffmpeg → MJPEG
                      ▼
               本機地面站（Python asyncio · FastAPI）── UDP ──> Tello 192.168.10.1
```

手把由主機上的瀏覽器讀取，所以 Docker 容器完全不需要 USB passthrough。

---

## 目錄

1. [先決條件](#先決條件)
2. [安裝](#安裝)（Docker／原生模式）
3. [首次設定](#首次設定)
4. [操作方式](#操作方式)
5. [安全機制](#安全機制)
6. [跟隨模式（自動跟著人飛）](#跟隨模式自動跟著人飛)
7. [防火牆設定（Windows／macOS）](#防火牆設定)
8. [Docker 的已知風險與判斷方式](#docker-的已知風險與判斷方式)
9. [診斷頁 /diag](#診斷頁-diag)
10. [模擬器](#模擬器)
11. [手機版（Android＋Termux）](#手機版androidtermux)
12. [常見問題](#常見問題)
13. [專案結構](#專案結構)
14. [開發與測試](#開發與測試)
15. [驗證範圍與真機首飛](#驗證範圍與真機首飛)

---

## 先決條件

| 項目 | 需求 |
|---|---|
| 網路 | 電腦 Wi-Fi 連上 `TELLO-XXXXXX` 之後**就沒有網際網路**。所有資源都已打包在專案裡（沒有 CDN、執行時不下載任何東西、只用系統字型）。**安裝、build 都要在連 Tello 之前、有網路時先做好。** |
| Docker（主要方式） | Docker Desktop（Windows／macOS）或 Docker Engine（Linux）。映像檔要在**有網路時**先 `docker compose build`。 |
| Python（備援方式） | 原生模式只需要 Python **3.10 以上**（已在 3.12、3.14 實測）。 |
| 瀏覽器 | **Chrome 或 Edge**，而且一定要用 **`http://localhost:8080`** 開啟。只有 localhost 才算 secure context，Gamepad API 與 WebCodecs 才能用；用 IP 開也會被 WebSocket 的 Origin 檢查拒絕。 |
| 手把 | Xbox 手把用 **USB 線**接電腦。Windows 10／11 原生支援；**macOS 需要 15 Sequoia 以上**才原生支援有線 Xbox 手把。 |
| Tello | 必須**已經用官方 Tello App 或 TelloFPV 啟用過一次**。沒啟用的 Tello 對 `takeoff` 只會回 `error`，介面會跳出「最可能的原因：尚未啟用」並列出其他可能原因。 |

程式啟動時會自動檢查 Python 版本、ffmpeg、UDP 8890／11111 與 HTTP 8080 是否被占用、本機是否在 Tello 網段，結果印在終端機，也會顯示在 `/diag`。

---

## 安裝

### A. Docker（主要方式）

在**有網路**的時候：

```bash
docker compose build
```

之後每次使用（可以離線）：

```bash
docker compose up -d
```

瀏覽器開 <http://localhost:8080>。結束：

```bash
docker compose down
```

- HTTP 只綁在 `127.0.0.1:8080`，區網其他電腦連不到。
- `8890/udp`（狀態）與 `11111/udp`（影像）會 publish 到所有介面（Tello 是主動送進來的）。
- `restart: "no"`：不會開機自動啟動，免得占住 UDP port，害原生模式不能用。
- `docker stop`／`docker compose down` 時，如果無人機還在空中，程式**收到 SIGTERM 的當下就會送出 land**，收尾時會再補送一次（已實測）。

**host networking 版本**（Linux，或已在 Docker Desktop 開啟 host networking 的人）：

```bash
docker compose -f compose.host.yml up -d
```

容器直接使用主機網路，不經過 Docker Desktop 的 UDP 轉發。

### B. 原生模式（不需要 Docker）

如果某台電腦的 Docker Desktop UDP 轉發不通，**先 `docker compose down`**，再改用原生模式：

- **Windows**：雙擊 `start-windows.bat`
- **macOS**：雙擊 `start-mac.command`（第一次若無法執行，請在終端機輸入 `chmod +x start-mac.command`）

腳本會自動找 Python 3.10 以上的版本、建立 `.venv`、安裝依賴，然後啟動地面站並打開瀏覽器。只有第一次執行（或 `requirements.txt` 改過時）需要網路，**請在連上 TELLO Wi-Fi 之前先執行一次**。

也可以手動執行：

```bash
python -m venv .venv
```

```bash
.venv/bin/pip install -r requirements.txt
```

```bash
.venv/bin/python -m gcs
```

（Windows 請把 `.venv/bin/` 換成 `.venv\Scripts\`。）

`ffmpeg` 是選用的：主要影像路徑（WebCodecs）不需要它，沒有 ffmpeg 只會停用 MJPEG 備援。

### 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `TELLO_IP` | `192.168.10.1` | Tello 位址 |
| `HTTP_PORT` | `8080` | 網頁 port |
| `HTTP_HOST` | `127.0.0.1` | 原生模式只綁本機（容器內是 `0.0.0.0`，但只 publish 到主機的 127.0.0.1） |
| `PUBLIC_PORT` | 同 `HTTP_PORT` | 瀏覽器看到的 port（Origin 檢查用） |
| `GCS_ALLOWED_ORIGINS` | 空 | 額外允許的 Origin（逗號分隔），一般不需要 |
| `GCS_NO_BROWSER` | 空 | 設了就不自動開瀏覽器（啟動腳本用） |

---

## 首次設定

1. **有網路時**：`docker compose build`（或執行一次 `start-windows.bat`／`start-mac.command`）。
2. 建議先用[模擬器](#模擬器)熟悉介面與按鍵。
3. 打開 Tello 電源，電腦 Wi-Fi 連上 `TELLO-XXXXXX`。
4. **Windows**：照[防火牆設定](#windows)把網路改成「私人」，或執行 `scripts\allow-firewall.ps1`。
   **macOS**：第一次執行時系統會問「是否允許 Python 接受傳入的網路連線」→ 按 **允許**。
5. 啟動地面站，用 Chrome／Edge 開 <http://localhost:8080>。
6. **按一下手把任一鍵**：瀏覽器規定要先有輸入，手把才會出現。
7. 先開 <http://localhost:8080/diag>，確認三種封包都有進來（見[真機首飛檢查清單](FIRST_FLIGHT.md)）。

---

## 操作方式

### 版面（16:9，最小 1280×720，支援全螢幕）

- **上方狀態列**（依重要性由左到右）：連線 → 電量（大字、進度條、預估剩餘飛行時間）→ 飛行時間 → Wi-Fi 訊號 → 溫度 → 速度模式
- **中央**：4:3 影像，上面疊著 HUD（高度、ToF、水平／垂直速度、航向、人工地平線）
- **左側**：飛前檢查、控制權；**右側**：姿態與鏈路、事件紀錄
- **左下、右下**：兩支搖桿的即時位置（含死區圈）與送出的 rc 數值
- **底部**：起飛、降落、影像、拍照、錄影、緊急停槳

### 手把（Mode 2）

| 按鍵 | 功能 |
|---|---|
| 左搖桿 | 上下＝升降、左右＝轉向 |
| 右搖桿 | 上下＝前後、左右＝左右平移 |
| **A** | 起飛（需通過飛前檢查） |
| **B** | 降落（立即送出、不排隊） |
| **Y** | 影像開／關 |
| 按住 **X** ＋ 十字鍵 | 翻滾（前／後／左／右）。電量 < 50% 時停用並說明原因 |
| 按住 **LT** | 精細 30% |
| 按住 **RT** | 全速 100%（放開＝一般 60%） |
| **LB ＋ RB** 同時按 | **緊急停槳：馬達立刻停止，無人機會直接掉下來** |
| **View** | 開關按鍵說明 |

搖桿死區預設 0.12（死區外重新縮放到 0–1），在「設定」可以調整死區與 expo 曲線。

### 鍵盤備援（手把故障時用）

| 按鍵 | 功能 |
|---|---|
| W／S | 前／後 |
| A／D | 左／右 |
| ↑／↓ | 升／降 |
| ←／→ | 轉向 |
| T | 起飛（同樣需要通過飛前檢查） |
| L | 降落 |
| V／P／R／F | 影像／拍照／錄影／全螢幕 |
| **Shift＋Esc** | 緊急停槳 |
| ? | 按鍵說明 |

### 滑鼠

- **緊急停槳要長按 1 秒**，按鈕上會顯示進度環；放開就取消。
- 拍照：把 canvas 存成 PNG 下載。錄影：MediaRecorder 存成 WebM（HUD 不會錄進去）。

### 飛前檢查（全部通過才允許起飛）

- Tello 已連線（有 SDK 回應，**而且**有收到狀態封包）
- 電量 > 20%
- 手把已偵測
- 兩支搖桿都置中

### 狀態與警示

色彩語意全站一致：**綠＝正常、琥珀＝警告、紅＝危急**，而且一律同時顯示圖示和文字（色盲友善）。

| 狀況 | 呈現 |
|---|---|
| 電量 ≤ 30% | 琥珀、HUD 警示 |
| 電量 ≤ 15% | 紅色閃爍、手把震動（飛行中每 20 秒提醒一次）。開啟「減少動態」時改成粗紅框、不閃爍 |
| 溫度 ≥ 門檻（預設 85°C，可在設定調整） | 琥珀警告 |
| 連線中斷 | 全畫面紅框＋大字，並說明是「與地面站程式」還是「與 Tello」的連線中斷 |
| 每個指令 | toast 顯示結果（成功／失敗／逾時／被中斷／被拒絕） |
| 起飛、降落、警告 | 手把震動；不支援震動時改成畫面邊框閃一下 |

### 多個分頁

同一時間只有一個**機長**分頁能控制。第一個打開的控制頁自動成為機長，其他分頁是**觀看模式**。
機長斷線時，其他分頁**不會自動升格**，必須按「接管控制」並確認。觀看模式只能送「降落」。
`/diag` 不算控制頁。

---

## 安全機制

全部移植自原型 `tello_pad.py`，而且每一條都有單元測試或整合測試：

- 自動送 `command` 進入 SDK 模式；狀態封包超過 **3 秒**沒進來就重新連線（換電池後會自動恢復）。
- 送需要等回應的指令（takeoff、flip、streamon 等）時，先**暫停 rc**，避免回應對到錯的指令；暫停前如果在空中，先送一次 `rc 0 0 0 0`。
- **land 與 emergency 不排隊、立即送出**；如果當時有指令正在等回應，該指令立即回傳 `interrupted`。
- 控制頁 WebSocket 斷線，或超過 **0.5 秒**沒收到 rc → 送 `rc 0 0 0 0` 懸停。
- 超過 **8 秒** → 自動降落，每次斷訊**只送 1 次**；5 秒後遙測仍顯示在空中才重送，**最多 3 次**。
  3 次都失敗、遙測仍在空中 → **停止送出任何指令**，讓 Tello 內建的「15 秒沒收到指令自動降落」接手。
- 程式結束時（Ctrl+C、關閉視窗、SIGTERM、`docker stop`）若在空中，**收到訊號當下就送 land**，收尾時再補送，然後才關閉 UDP socket。
- 指令白名單；rc 數值一律夾在 −100 到 100（NaN、字串、超大值都安全處理）。
- WebSocket 檢查 Origin，只接受 `http://localhost:8080` 與 `http://127.0.0.1:8080`。
- 切到其他分頁時，瀏覽器會暫停送 rc → 0.5 秒後自動懸停。

---

## 跟隨模式（自動跟著人飛）

控制頁左側的「跟隨模式」面板。用鏡頭畫面偵測人的姿勢，自動轉向、前後移動、維持高度，讓選定的人一直在畫面中央、保持固定距離。
偵測在瀏覽器裡用 **MediaPipe Pose（lite）** 執行（GPU 加速，每幀約 15 ms）；「停到手上」另外用 **MediaPipe Hand** 判斷手掌是否張開。模型與執行環境都放在 `web/vendor/mediapipe/`（約 27 MB），**完全離線**；第一次開啟跟隨模式時才載入，不影響一般飛行。

### 使用步驟

1. 開影像（**Y**），讓要跟的人站在鏡頭前 2–4 m、全身或至少上半身＋髖部入鏡。
2. 按手把 **Menu（≡）** 或鍵盤 **G** 開啟跟隨模式。畫面上每個人會有一個編號框。
   - 只有一個人 → 自動鎖定。
   - 多個人 → **十字鍵 ←／→**（或鍵盤 **N**）依畫面左右順序切換，或**直接點畫面上的人**，或點面板上的 `#1`、`#2` 按鈕。綠色實線框＝正在跟的人。
3. 起飛（**A**）。起飛後以「當下的距離與高度」當作設定值開始跟隨。
4. 再按一次 **Menu**／**G** 關閉，回到純手動。

### 手勢（由被跟的人做，維持約 0.6 秒）

| 手勢 | 效果 |
|---|---|
| 舉**右手**過頭（被拍的人自己的右手） | 升高 30 cm（維持不放每秒再升一次） |
| 舉**左手**過頭 | 降低 30 cm |
| 雙手高舉過頭（Y 字） | 拉遠 0.5 m |
| 雙手在胸前交叉 | 靠近 0.5 m（最近可以設定到 0.5 m） |
| 雙手側平舉（T 字） | 暫停（原地懸停、繼續追蹤）／再做一次恢復；停到手上進行中＝取消 |
| 手臂**向前伸**（朝著無人機）、**手掌張開** | **停到手上**（見下方） |

用手臂姿勢而不用手指手勢，是因為無人機通常離人 2–5 m，手指在 960×720 畫面上只有十幾個像素，辨識不可靠；手臂姿勢在這個距離很穩定。
畫面下方會顯示手勢累積進度，觸發時有 toast 與手把震動。只有被跟的那個人的手勢有效，旁邊的人怎麼揮都不會影響。

### 手臂要一直看得見（高度限制）

手勢全部靠手臂姿勢，所以跟隨時的高度一律夾在「手臂看得見」的範圍內：

- **下限**：再低的話，舉過頭的手會跑出畫面上緣 → 不會再降。
- **上限**：再高的話，髖部會跑出畫面下緣（看不到胸前交叉，也沒辦法估距離）→ 不會再升。
- 舉手調高度時如果碰到上下限，toast 會說明「已到上限／下限」。面板的「設定 距離／高度」會顯示實際飛的高度，例如 `60 cm → 150 cm（保持手臂在畫面內）`。
- 範圍是用畫面中人的肩膀、髖部位置與估計距離即時算出來的（舉手時手腕約在肩膀上方 1.45 個軀幹長，上下各留 6% 邊）。
- 距離太近（約 1.3 m 以內）時，舉起的手和軀幹沒辦法同時入鏡：這時**優先保住軀幹**（才能估距離、看得到胸前手勢與向前伸的手），舉過頭的手可能會被切掉，升高／降低／拉遠手勢要退遠一點再做。

### 停到手上

1. 跟隨中（或暫停中），被跟的人把**一隻手臂向前伸、手掌張開**，維持約 0.6 秒。
2. 無人機轉向對準那隻手，慢慢飛到手前方約 **50 cm**、比手**略高**的位置懸停（前進速度上限 18、肩寬顯示太近時一律後退）。畫面上的虛線框是手掌要對準的位置。
3. 面板顯示「把手掌移到機身正下方」→ 把張開的手掌**移到無人機正下方**（鏡頭看不到正下方，這一段由人來做）。
4. 下方 ToF 感測器的距離突然變短（比懸停時少 25 cm 以上、而且小於 60 cm，連續 3 筆）→ 送 `land`，Tello 降落在手上，**螺旋槳自動停止**。

取消方式：推任何一支搖桿、做 T 字手勢；接近途中看不到手超過 1.5 秒、懸停等待 20 秒沒有偵測到手掌也會自動取消。取消後恢復跟隨，退回原本的距離。
**B 降落、LB＋RB 緊急停槳**隨時有效。

> 第一次請在室內、裝保護罩、低速下練習。手掌要張開、手指併攏、掌心朝上，伸到機身正下方中央；不要從側面去抓。

### 手把介入

- **推任何一支搖桿**（離開死區）→ 立刻完全改成手動控制，面板顯示「手動介入中」。
- 放開搖桿 **1 秒**後自動恢復跟隨，而且**以當下的高度與距離當作新的設定值**——想調整構圖，直接用搖桿飛到想要的位置再放開就好。
- **B 降落、LB＋RB 緊急停槳、鍵盤 L／Shift+Esc** 在跟隨模式中一樣隨時有效。

### 跟隨時的安全設計

- 輸出有上限：轉向 ±50、前後 ±35、升降 ±40（rc 值），而且每 33 ms 最多變化 9；減速、停止不受限制。
- 只轉向、不左右平移；目標快跑出畫面邊緣時先轉、前進減半。
- 估計距離 < 0.4 m 一律後退；1.5 m 以內前進速度上限降為 18；看不到髖部（只看得到上半身）時無法估距離 → **不會往前**，只會在太近時後退。
- 目標 0.45 秒沒出現 → 原地懸停（rc 全 0）。3 秒內回到附近（位置、大小、衣服顏色都相近）會自動找回；超過 3 秒就放掉，**必須手動重新選人**，不會自動改跟別人。
- 用衣服顏色輔助辨認，兩個人交錯走過時不容易認錯。
- 高度設定限制在 60–300 cm（Tello 回報的相對高度），並且一律夾在「手臂看得見」的範圍內；距離 0.5–6 m。
- 電量 ≤ 15% 自動關閉跟隨；被其他分頁接管控制時也會關閉。
- 原本的保護全部照舊：分頁切到背景 0.5 秒懸停、8 秒自動降落。

### 限制

- 距離是用「肩膀到髖部約 0.5 m」換算的估計值，小孩、彎腰、坐下時會偏遠（無人機會靠近一點）。現在可以設定到 0.5 m，**近距離時估計誤差的影響更大**，請隨時準備用搖桿介入。
- 光線很暗、逆光、人很遠（> 6 m）時偵測不穩，面板的「偵測」fps 會下降或出現「目標遺失」。
- 不會避障。請在空曠處使用，跟隨時操作者手一定要在手把上。
- 手機版（`tello_pad.py`）沒有跟隨模式：它只用 Python 標準函式庫、影像是 MJPEG，手機瀏覽器跑姿勢模型也太吃電。

---

## 防火牆設定

Tello 的狀態（UDP 8890）和影像（UDP 11111）是 **Tello 主動送進電腦的入站封包**，防火牆擋住就會「有指令回應、卻沒有狀態／影像」。

### Windows

連上 TELLO 的 Wi-Fi 時，Windows 會把它歸類成**公用網路**，而公用網路預設會擋入站 UDP。

> **最常見的情況：防火牆裡有「封鎖」規則**
> 第一次執行時跳出的「Windows 安全性警訊」如果被取消、關掉，或只勾了私人網路，Windows 會自動替那個 python.exe 建立**公用網路、入站、封鎖**規則（名稱就叫「Python」）。
> 結果就是「有指令回應、收不到狀態封包」。**封鎖規則的優先權高於允許規則**，所以一定要先刪掉它。
> 原生模式啟動時會自動檢查，有的話會在終端機和 `/diag` 顯示 `[錯誤] Windows 防火牆封鎖了這個 Python 的入站連線`，並附上修正指令。
>
> 修正方式（系統管理員 PowerShell，在專案資料夾執行；這個腳本會先刪掉封鎖規則，再新增只限 Tello 子網路的允許規則）：
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1
> ```
>
> 只想看看有沒有封鎖規則（不需要系統管理員）：
>
> ```powershell
> Get-NetFirewallApplicationFilter -Program (.venv\Scripts\python.exe -c "import sys; print(sys._base_executable)") | Get-NetFirewallRule | Where-Object Action -eq Block | Select-Object DisplayName, Profile, Direction
> ```

以下兩種方法擇一（都要用**系統管理員**身分開 PowerShell）：

**方法 1：把 TELLO 網路改成「私人」**（先連上 `TELLO-XXXXXX` 再執行）

```powershell
Get-NetConnectionProfile | Where-Object Name -like 'TELLO-*' | Set-NetConnectionProfile -NetworkCategory Private
```

確認目前的網路類型：

```powershell
Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, NetworkCategory
```

改成私人之後，第一次執行時跳出的「Windows 安全性警訊」請勾選**私人網路**並按允許。

**方法 2：只對 Tello 子網路開放這兩個 port**（不改網路類型，任何網路類型都適用）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1
```

這個腳本會替**原生模式的 python.exe**（venv 背後真正執行的那一個）和 **Docker Desktop 的 `com.docker.backend.exe`** 各新增一條入站規則：只允許 UDP 8890、11111，而且來源只限 `192.168.10.0/24`。

也可以手動新增（把路徑換成你的 python.exe）：

```powershell
New-NetFirewallRule -DisplayName "Tello GCS (python)" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 8890,11111 -RemoteAddress 192.168.10.0/24 -Program "C:\Python312\python.exe"
```

```powershell
New-NetFirewallRule -DisplayName "Tello GCS (Docker)" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 8890,11111 -RemoteAddress 192.168.10.0/24 -Program "$env:ProgramFiles\Docker\Docker\resources\com.docker.backend.exe"
```

查看 venv 背後真正的 python.exe 路徑：

```powershell
.venv\Scripts\python.exe -c "import sys; print(sys._base_executable)"
```

### macOS

- 第一次執行時會跳出「是否要讓 Python 接受傳入的網路連線？」→ **一定要按「允許」**。
- 如果之前按了拒絕：**系統設定 → 網路 → 防火牆 → 選項**，把 Python（原生模式）或 Docker（Docker 模式）改成「允許傳入連線」。
- 也可以用指令（原生模式）：

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(.venv/bin/python -c 'import sys; print(sys._base_executable)')"
```

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(.venv/bin/python -c 'import sys; print(sys._base_executable)')"
```

---

## Docker 的已知風險與判斷方式

Docker Desktop（Windows／macOS）的 UDP 是由**使用者空間的程序**轉發，可能出現兩種狀況：

1. **收不到 Tello 主動送來的封包**：有指令回應，但狀態／影像封包是 0。
2. **NAT 逾時**：一開始正常，過一陣子狀態封包中斷，但指令還有回應。

打開 `/diag` 就能分辨（頁面會直接給出建議）：

| 指令回應 | 狀態封包 | 判斷 | 處理 |
|---|---|---|---|
| 有 | 0，從來沒有過 | 防火牆擋入站 UDP 8890，或 Docker Desktop 收不到主動送入的封包 | 先照上面設定防火牆；仍不行就 `docker compose down` 改用原生模式 |
| 有 | 原本有、後來中斷 | Docker Desktop 的 UDP NAT 逾時 | `docker compose restart` 可暫時恢復；長期請改用原生模式或 `compose.host.yml` |
| 沒有 | 0 | Wi-Fi 沒連上 Tello，或其他程式占用 | 確認 Wi-Fi、關掉 TelloFPV／官方 App |
| 有 | 正常，但 streamon 後影像 0 | 防火牆擋 UDP 11111 | 同狀態封包的解法 |

---

## 診斷頁 /diag

<http://localhost:8080/diag> 即時顯示：

- 指令回應的 RTT（最近、平均、最大）、成功／逾時／錯誤數
- 每秒狀態封包數、最後一個距今多久、來源位址
- 影像封包每秒數量、位元率、重組後 fps、關鍵幀數、codec、塞車丟幀數
- WebSocket 連線狀態與往返延遲、機長是哪個分頁
- 瀏覽器能力（secure context、Gamepad、WebCodecs、H.264 解碼、MediaRecorder）
- 手把 id、mapping、原始 axes 與 buttons
- 啟動檢查結果

任何一項異常都會在最上方列出**具體的排除建議**，例如「有指令回應、但收不到狀態封包 → 多半是防火牆擋了入站 UDP 8890」。

---

## 模擬器

`sim/mock_tello.py` 會模擬指令回應、10 Hz 狀態封包、ffmpeg testsrc H.264 影像（切成 1460 byte 的 UDP 封包，跟真機一樣）、未啟用、電量消耗、溫度上升，以及 Tello 內建的「15 秒沒收到指令自動降落」。沒有無人機也能完整跑一遍。

**Docker**（明確使用 override 檔，不會自動切換）：

```bash
docker compose -f compose.yml -f compose.sim.yml up
```

用完請用**同一組檔案** down，避免模擬器容器留著：

```bash
docker compose -f compose.yml -f compose.sim.yml down
```

**原生模式**：

```bash
python -m sim.dev
```

或 `start-windows.bat --sim`、`./start-mac.command --sim`。

模擬器模式下，畫面右上角會一直顯示琥珀色的「模擬器」標籤。

模擬器參數（`python -m sim.mock_tello --help`）：`--not-activated`（takeoff 回 error）、`--no-state`（模擬防火牆擋 8890）、`--ignore-land`（測試自動降落重送與放棄）、`--battery N`、`--drain 秒`。

---

## 手機版（Android＋Termux）

沒有電腦時，可以用原型 `tello_pad.py` 直接在 Android 手機上飛：

```
Xbox 手把 ──藍牙──> 手機 Chrome（http://127.0.0.1:8080）──> tello_pad.py（Termux）── UDP ──> Tello
```

只用 Python 標準函式庫，不需要 `pip install`；有裝 ffmpeg 才有影像（MJPEG）。

### 安裝（有網路時做一次）

1. 從 **F-Droid** 或 GitHub 安裝 **Termux**（Play 商店的版本太舊，`pkg` 會裝不起來）。
2. 打開 Termux，安裝 Python 與 ffmpeg：

```bash
pkg update && pkg install python ffmpeg
```

3. 把 `tello_pad.py`（和選用的 `tello_check.py`）放進 Termux 的家目錄。例如先下載到手機的「下載」資料夾，再：

```bash
termux-setup-storage
```

```bash
cp ~/storage/downloads/tello_pad.py ~/storage/downloads/tello_check.py ~/
```

（或在 Termux 裡 `pkg install git` 後 `git clone` 整個專案。）

4. 手機「設定 → 藍牙」配對 Xbox 手把（手把按住配對鍵直到 Xbox 鍵快閃）。

### 每次飛行

1. Tello 開機，手機 Wi-Fi 連上 `TELLO-XXXXXX`。Android 提示「這個網路無法連上網際網路」時選**保持連線**。
2. **關閉行動數據**：否則 Android 可能把封包走行動網路，出現「等待 Tello…」。
3. 在 Termux 執行：

```bash
python tello_pad.py
```

4. 用 **Chrome** 開 <http://127.0.0.1:8080>，**按一下手把任一鍵**讓頁面偵測到手把。
5. （選用）先確認電量與基本資訊：`python tello_check.py`（`--watch` 持續顯示）。
6. 結束：回到 Termux 按 **Ctrl+C**（Termux 鍵盤列的 CTRL 再按 C）。若還在空中，程式會先送 land 再結束。

**建議**：下拉 Termux 通知選「Acquire wakelock」（或執行 `termux-wake-lock`），避免切到 Chrome 後 Android 把 Termux 暫停或殺掉；頁面本身會在點擊後保持螢幕常亮。

### 按鍵與安全機制

手把對應與電腦版相同（Mode 2；A 起飛、B 降落、Y 影像、X＋十字鍵翻滾、LT 精細、RT 全速、**LB＋RB 緊急停槳**）。
斷訊 0.5 秒懸停、8 秒自動降落、自動 SDK 模式與重連也都有。

和電腦版的差異：

- 沒有飛前檢查、HUD、診斷頁、多分頁機長機制、鍵盤備援。
- 畫面上的「緊急停槳」按鈕是**點一下就停槳**（沒有長按確認），請小心誤觸。
- rc 送出頻率是 20 Hz（電腦版 30 Hz）；影像只有 MJPEG，延遲比電腦版的 WebCodecs 高。

---

## 常見問題

**Q：畫面一直顯示「等待 Tello…」**
確認電腦 Wi-Fi 連的是 `TELLO-XXXXXX`、Tello 已開機（燈號閃黃）、沒有其他程式（TelloFPV、官方 App）同時連著。打開 `/diag` 看排除建議。

**Q：「等待狀態封包」——有回應但沒有狀態**
幾乎都是防火牆，而且最常見的是 Windows 自動建立的**封鎖規則**（見[防火牆設定](#windows)）：以系統管理員執行 `scripts\allow-firewall.ps1`，再重新啟動地面站。
注意：防火牆規則是**綁在 python.exe 的路徑上**。所以用 Anaconda 的 Python 跑 `tello_check.py` 收得到狀態，不代表地面站用的 Python（原生模式是 `.venv` 背後的那個）也收得到。Docker 模式仍不行就改用原生模式。

**Q：起飛失敗，跳出「最可能是這台 Tello 尚未啟用」**
Tello 對 takeoff 只回 `error`，沒有說明原因，所以只能推測。請用官方 Tello App 或 TelloFPV 連線啟用一次。其他可能原因：電量 < 10%、過熱、IMU 需要校正（放在平坦地面重開機）、螺旋槳卡住。

**Q：沒偵測到手把**
在頁面上按一下手把任一鍵。確認用 Chrome／Edge、網址是 `localhost`。macOS 需要 15 Sequoia 以上。`/diag` 會顯示 mapping；不是 `standard` 時按鍵可能錯位。

**Q：影像是黑的**
按 Y 開影像後等 1–2 秒（要等第一個關鍵幀）。瀏覽器不支援 WebCodecs H.264 時會自動改用 MJPEG 備援（需要 ffmpeg）。`/diag` 的影像卡片會顯示封包數與關鍵幀數。

**Q：用 `http://192.168.x.x:8080` 開不了**
這是刻意的：HTTP 只綁本機，WebSocket 也只接受 localhost 的 Origin。請用 `http://localhost:8080`。

**Q：原生模式說 UDP 8890 被占用**
Docker 版還在跑（`docker compose down`），或開著 TelloFPV／另一個地面站。

**Q：換電池之後**
全畫面紅框「與 Tello 的連線中斷」是正常的；開機、Wi-Fi 重新連上後會自動重連，紅框消失。

**Q：分頁切到背景，無人機停住了**
這是安全設計：背景分頁的計時器會被瀏覽器降速，0.5 秒沒送出控制就懸停，8 秒自動降落。飛行時請讓控制頁保持在前景。

---

## 專案結構

```
tello_pad.py              原型（Android Termux 版，保留作為協定與安全邏輯的參考）
README.md                 本文件
FIRST_FLIGHT.md           真機首飛檢查清單（可列印）
Dockerfile                python:3.12-slim ＋ ffmpeg
compose.yml               一般使用（127.0.0.1:8080、8890/udp、11111/udp）
compose.sim.yml           模擬器 override
compose.host.yml          host networking 版本
start-windows.bat         原生模式（Windows）：venv → 依賴 → 啟動
start-mac.command         原生模式（macOS）
requirements.txt          執行期依賴（版本鎖定，cp310/cp312/cp314 都有 wheel）
requirements-dev.txt      測試用（pytest、httpx、playwright）
scripts/allow-firewall.ps1  Windows 防火牆規則（只開放 Tello 子網路）
gcs/                      後端
  __main__.py             進入點、啟動檢查、訊號處理（收到結束訊號立即 land）
  config.py               所有參數與環境變數
  protocol.py             白名單、rc 夾限、狀態解析、回應分類、起飛失敗推測、電量估算
  link.py                 TelloLink：UDP 收發、ask／immediate、SDK 保活與重連、rc 迴圈
  safety.py               斷訊懸停／自動降落狀態機（純邏輯）
  h264.py                 分片重組：封包 → NAL → access unit，SPS/PPS 快取與補齊、codec string
  video.py                UDP 11111 接收、/ws/video 扇出（塞車時丟到下一個 IDR）、ffmpeg MJPEG 備援
  diag.py                 診斷計數器
  preflight.py            啟動檢查
  server.py               FastAPI：WebSocket（Origin 檢查、單一機長）、API、靜態檔
web/                      前端（無 build step，原生 ES modules）
  index.html  diag.html
  js/follow/              跟隨模式：pose.js（MediaPipe）、geometry.js（框與距離估計）、tracker.js（多人編號）、
                          gestures.js（手臂手勢）、control.js（rc 控制器、手臂可見高度範圍）、
                          hand.js（MediaPipe Hand）、palm.js（停到手上：手掌張開判斷、狀態機）、
                          follow.js（整合、畫框、手把介入）
  vendor/mediapipe/       MediaPipe Tasks Vision＋pose_landmarker_lite 模型（離線用，見 VENDOR.md）
  css/tokens.css          色彩與字級 token（WCAG AA 已由測試驗證）
  css/app.css  css/diag.css
  js/main.js              主程式：輸入 → rc 30 Hz、遙測 → 畫面、警示、動作
  js/ws.js  gamepad.js  keyboard.js  curve.js  video.js  hud.js
  js/preflight.js  toast.js  recorder.js  settings.js  diag.js
sim/
  mock_tello.py           模擬 Tello
  dev.py                  原生模式一鍵模擬（模擬器＋地面站）
tests/
  unit/                   協定、rc 夾限、安全時序、H.264 重組、link、Origin／機長、色彩對比
  js/                     跟隨模式純邏輯（node --test）：距離估計、多人追蹤、手勢、控制器
  integration/test_sim.py 真的啟動 gcs ＋模擬器，走完整條控制鏈
  e2e/test_ui.py          Playwright：假手把注入、按鍵、搖桿數值、截圖
  e2e/test_follow.py      跟隨模式：模擬器閉迴路（轉向、手勢、介入、換目標、遺失、手臂可見高度、停到手上）＋真模型
  e2e/screenshots/        1280×720、1920×1080 等截圖
```

---

## 開發與測試

```bash
pip install -r requirements-dev.txt
```

```bash
python -m pytest
```

- `tests/unit`：rc 夾限、白名單、狀態封包解析、電量估算、斷訊懸停／自動降落時序（假時鐘）、ask 期間暫停 rc、land 打斷 ask、重連、結束時降落、H.264 分片重組（含真實 x264 串流）、Origin 檢查、單一機長、WCAG 對比。
- `tests/integration`：子行程啟動 `python -m gcs` ＋模擬器，驗證起飛、影像（WebCodecs 與 MJPEG）、斷線 8 秒自動降落（實際時序）、Ctrl+Break 結束時降落。
- `tests/js`：跟隨模式的純邏輯，用 Node 內建的 `node --test`（`tests/unit/test_js.py` 會自動呼叫；沒裝 Node 就跳過）。
- `tests/e2e/test_follow.py`：用合成的人取代偵測模型、在模擬器上跑完整閉迴路；另外在 Edge 載入真的 MediaPipe 模型偵測一張真人照片（MediaPipe 官方範例圖，第一次執行時下載到 `.pytest_cache`，離線就跳過）。
- `tests/e2e`：Playwright 使用本機已安裝的 **Edge**（Playwright 內建的 Chromium 沒有 H.264 解碼器）。改用 Chrome：設環境變數 `E2E_CHANNEL=chrome` 後再執行。

---

## 驗證範圍與真機首飛

見 [FIRST_FLIGHT.md](FIRST_FLIGHT.md)：列出哪些部分只在模擬器上驗證過，以及真機第一次飛行的逐步檢查清單。
