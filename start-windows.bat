@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Tello 地面站（原生模式）

rem ===== 找 Python 3.10 以上 =====
set "PY="
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 (
    python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 set "PY=python"
  )
)
if not defined PY (
  echo [錯誤] 找不到 Python 3.10 以上。
  echo        請到 https://www.python.org/downloads/ 安裝，安裝時勾選「Add python.exe to PATH」。
  goto :end
)

rem ===== 建立 venv 並安裝依賴（只有第一次或 requirements.txt 改過才需要網路）=====
if not exist ".venv\Scripts\python.exe" (
  echo 建立虛擬環境 .venv …
  %PY% -m venv .venv
  if errorlevel 1 goto :venvfail
)
set "VPY=.venv\Scripts\python.exe"
fc /b requirements.txt .venv\requirements.installed >nul 2>nul
if errorlevel 1 (
  echo 安裝依賴套件（需要網路；請在連上 TELLO Wi-Fi 之前先執行一次）…
  "%VPY%" -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 goto :pipfail
  copy /y requirements.txt .venv\requirements.installed >nul
)

where ffmpeg >nul 2>nul
if errorlevel 1 echo [提示] 找不到 ffmpeg：主要影像路徑（WebCodecs）不需要，只有 MJPEG 備援會停用。

rem ===== 2 秒後開瀏覽器 =====
if not defined GCS_NO_BROWSER start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8080"

if /i "%~1"=="--sim" (
  echo 模擬器模式：不會控制真的無人機
  "%VPY%" -m sim.dev
) else (
  "%VPY%" -m gcs
)
goto :end

:venvfail
echo [錯誤] 無法建立虛擬環境 .venv
goto :end

:pipfail
echo [錯誤] 依賴安裝失敗。電腦目前可能沒有網路（連著 TELLO Wi-Fi？）。
echo        請先切回有網路的 Wi-Fi 執行一次，之後就能離線使用。
goto :end

:end
echo.
pause
endlocal
