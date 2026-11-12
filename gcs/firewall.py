"""Windows 防火牆檢查：找出「封鎖」目前這個 python.exe 入站連線的規則。

Windows 第一次看到某個程式監聽網路時會跳出「Windows 安全性警訊」。如果當時按了取消、
或只勾了私人網路，就會自動建立「Query User」的**封鎖**規則（公用網路、入站、TCP 和 UDP 各一條）。
連上 TELLO 的 Wi-Fi 屬於公用網路，所以 Tello 主動送來的狀態（8890）與影像（11111）會被擋，
但指令回應（電腦先送出去的回覆）仍然收得到 —— 正好是「有指令回應、收不到狀態封包」。

封鎖規則的優先權高於允許規則，所以光新增允許規則沒有用，必須先刪掉封鎖規則。
"""
from __future__ import annotations

import os
import subprocess
import sys
from typing import Optional


def python_program() -> str:
    """實際在監聽 UDP 的執行檔（venv 的 python.exe 只是啟動器，真正跑的是基底 python）。"""
    return getattr(sys, "_base_executable", None) or sys.executable


def blocking_rules(program: Optional[str] = None, timeout: float = 8.0) -> Optional[list[dict]]:
    """回傳封鎖這個程式入站連線、而且已啟用的規則。非 Windows 或查不到時回傳 None。"""
    if os.name != "nt":
        return None
    program = program or python_program()
    script = (
        "$ErrorActionPreference='SilentlyContinue';"
        "Get-NetFirewallApplicationFilter -Program $env:GCS_FW_PROGRAM | Get-NetFirewallRule |"
        " Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } |"
        " ForEach-Object { '{0}|{1}' -f $_.DisplayName, $_.Profile }"
    )
    env = dict(os.environ, GCS_FW_PROGRAM=program)
    try:
        r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                           capture_output=True, timeout=timeout, env=env,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = r.stdout.decode("mbcs" if os.name == "nt" else "utf-8", "replace")
    rules = []
    for line in text.splitlines():
        if "|" in line:
            name, profile = line.rsplit("|", 1)
            rules.append({"name": name.strip(), "profile": profile.strip()})
    return rules


def fix_command(program: Optional[str] = None) -> str:
    """給使用者在「系統管理員」PowerShell 執行的修正指令。"""
    program = program or python_program()
    return (f"Get-NetFirewallApplicationFilter -Program '{program}' | Get-NetFirewallRule | "
            "Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule")
