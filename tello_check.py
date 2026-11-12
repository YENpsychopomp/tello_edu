#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tello_check.py — 快速確認 Tello 電量與基本資訊（只用 Python 標準函式庫）

用法（手機 Termux 或電腦都可以）：
  1. Tello 開機，Wi-Fi 連上 TELLO-XXXXXX
  2. python tello_check.py           ← 查一次就結束
     python tello_check.py --watch   ← 持續顯示電量，Ctrl+C 結束
"""
import argparse
import re
import socket
import sys
import time
import unicodedata

# (查詢, 標籤, 回應格式)。數字型和文字型交錯排列，晚到的回應比較容易被格式檢查擋掉
QUERIES = [
    ("battery?", "電量 (%)", r"\d{1,3}"),
    ("sn?", "序號", r"[0-9A-Z]{8,}"),
    ("sdk?", "SDK 版本", r"[123]0"),
    ("temp?", "機身溫度", r"\d+~\d+C?"),
    ("wifi?", "Wi-Fi 訊號 (SNR)", r"\d{1,3}"),
]


def pad(text, width):
    """中文字在終端機佔兩格，用顯示寬度補空白才會對齊。"""
    w = sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)
    return text + " " * max(0, width - w)


def battery_verdict(bat):
    if bat >= 95:
        return "已充飽 ✅"
    if bat >= 50:
        return "可以飛 ✅（翻滾需要 ≥ 50%）"
    if bat >= 20:
        return "電量偏低 ⚠️  建議先充電"
    return "電量過低 ❌  請先充電"


def parse_state(raw):
    st = {}
    for kv in raw.split(";"):
        if ":" in kv:
            k, v = kv.split(":", 1)
            st[k.strip()] = v.strip()
    return st


class Tello:
    def __init__(self, ip):
        self.addr = (ip, 8889)
        self.cmd = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.cmd.bind(("", 0))
        self.state = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.state.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.state.bind(("", 8890))
        except OSError:
            print("⚠️  UDP 8890 被占用（tello_pad.py 或地面站是不是還開著？），略過狀態封包")
            self.state = None

    def _drain(self):
        """丟掉之前逾時才晚到的回應，避免答非所問。"""
        self.cmd.setblocking(False)
        try:
            while True:
                self.cmd.recvfrom(1024)
        except (BlockingIOError, OSError):
            pass
        finally:
            self.cmd.setblocking(True)

    def ask(self, q, timeout=3.0, retries=0, expect=None):
        """送出查詢並等回應。expect 是正規表示式：格式不符的回應（例如上一題晚到的答案）會被丟掉。"""
        for _ in range(retries + 1):
            self._drain()
            try:
                self.cmd.sendto(q.encode(), self.addr)
            except OSError as e:
                return None, f"送不出去：{e}"
            deadline = time.time() + timeout
            while True:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.cmd.settimeout(left)
                try:
                    data, _ = self.cmd.recvfrom(1024)
                except socket.timeout:
                    break
                r = data.decode("utf-8", "replace").strip()
                if expect is None or re.fullmatch(expect, r) or r.startswith(("error", "unknown")):
                    return r, None
            time.sleep(0.8)          # 讓逾時後才晚到的回應先進來，下一輪 _drain 會把它丟掉
        return None, "沒有回應"

    def read_state(self, timeout=2.0):
        if not self.state:
            return None
        self.state.settimeout(timeout)
        try:
            data, _ = self.state.recvfrom(2048)
            return parse_state(data.decode("utf-8", "replace"))
        except socket.timeout:
            return None


def main():
    ap = argparse.ArgumentParser(description="確認 Tello 電量與基本資訊")
    ap.add_argument("--ip", default="192.168.10.1", help="Tello IP（預設 192.168.10.1）")
    ap.add_argument("--watch", action="store_true", help="持續顯示電量，Ctrl+C 結束")
    args = ap.parse_args()

    t = Tello(args.ip)
    print(f"連線 Tello（{args.ip}）…")
    resp, err = t.ask("command", retries=2)
    if resp is None:
        print(f"\n❌ 連不上 Tello：{err}")
        print("   請確認：")
        print("   1. Tello 已開機（指示燈在閃）")
        print("   2. 這台裝置的 Wi-Fi 連的是 TELLO-XXXXXX（手機要關行動數據）")
        print("   3. 剛用過其他 App（TelloFPV 等）→ Tello 關機再開機")
        print("   4. Windows：TELLO 網路被當成「公用網路」時，防火牆可能擋掉回應")
        sys.exit(1)
    if resp == "unactive":
        print("⚠️  Tello 回應 unactive：尚未啟用，請先用官方 App 或 TelloFPV 連一次")
    elif resp != "ok":
        print(f"⚠️  進入 SDK 模式的回應不是 ok：{resp}")
    else:
        print("✅ 已連上（SDK 模式）\n")

    results = {}
    for q, label, expect in QUERIES:
        r, e = t.ask(q, expect=expect)
        results[q] = r
        print(f"  {pad(label, 18)}{r if r is not None else '（' + e + '）'}")

    bat = None
    try:
        bat = int(results.get("battery?") or "")
    except ValueError:
        pass

    st = t.read_state()
    if st:
        print(f"\n  狀態封包：電量 {st.get('bat', '?')}%｜"
              f"溫度 {st.get('templ', '?')}~{st.get('temph', '?')}°C｜"
              f"高度 {st.get('h', '?')} cm｜飛行時間 {st.get('time', '?')} s")
        if bat is None and st.get("bat", "").isdigit():
            bat = int(st["bat"])
    elif t.state:
        print("\n  （沒收到狀態封包：查詢功能正常就不影響；"
              "Windows 多半是防火牆擋了入站 UDP 8890）")

    if bat is not None:
        print(f"\n🔋 電量 {bat}% → {battery_verdict(bat)}")
    else:
        print("\n❓ 讀不到電量數值")

    if not args.watch:
        return

    print("\n持續監看中（Ctrl+C 結束）…")
    try:
        while True:
            st = t.read_state(timeout=1.5)
            if st and st.get("bat", "").isdigit():
                b, src = int(st["bat"]), f"溫度 {st.get('temph', '?')}°C"
            else:
                r, _ = t.ask("battery?", timeout=2.0, expect=QUERIES[0][2])
                b = int(r) if r and r.isdigit() else None
                src = "（查詢）"
                time.sleep(1.0)
            line = f"{time.strftime('%H:%M:%S')}  電量 {b if b is not None else '--'}%  {src}"
            print("\r" + line.ljust(50), end="", flush=True)
    except KeyboardInterrupt:
        print("\n結束")


if __name__ == "__main__":
    main()