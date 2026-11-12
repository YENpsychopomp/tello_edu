#!/bin/bash
# Tello 地面站（原生模式，macOS）。雙擊執行；第一次若無法執行請在終端機：chmod +x start-mac.command
cd "$(dirname "$0")" || exit 1

PY=""
for c in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
if [ -z "$PY" ]; then
  echo "[錯誤] 找不到 Python 3.10 以上（macOS 內建的 python3 可能是 3.9）。"
  echo "       請到 https://www.python.org/downloads/macos/ 安裝，或 brew install python@3.12"
  read -r -p "按 Enter 結束…" _; exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "建立虛擬環境 .venv …"
  "$PY" -m venv .venv || { echo "[錯誤] 無法建立 .venv"; read -r -p "按 Enter 結束…" _; exit 1; }
fi
if ! cmp -s requirements.txt .venv/requirements.installed; then
  echo "安裝依賴套件（需要網路；請在連上 TELLO Wi-Fi 之前先執行一次）…"
  if .venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt; then
    cp requirements.txt .venv/requirements.installed
  else
    echo "[錯誤] 依賴安裝失敗。電腦目前可能沒有網路（連著 TELLO Wi-Fi？）。先切回有網路的 Wi-Fi 執行一次。"
    read -r -p "按 Enter 結束…" _; exit 1
  fi
fi

command -v ffmpeg >/dev/null 2>&1 || echo "[提示] 找不到 ffmpeg：主要影像路徑（WebCodecs）不需要，只有 MJPEG 備援會停用（brew install ffmpeg）。"
echo "[提示] 第一次執行時 macOS 會問「是否允許 Python 接受傳入的網路連線」→ 請按「允許」，否則收不到 Tello 的狀態與影像。"

[ -z "$GCS_NO_BROWSER" ] && (sleep 2; open "http://localhost:8080") &

if [ "$1" = "--sim" ]; then
  echo "模擬器模式：不會控制真的無人機"
  exec .venv/bin/python -m sim.dev
else
  exec .venv/bin/python -m gcs
fi
