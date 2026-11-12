"""啟動檢查：在終端機印出，也透過 /api/diag 給診斷頁顯示。"""
from __future__ import annotations

import shutil
import socket
import sys
from dataclasses import asdict, dataclass

from .config import Settings
from .firewall import blocking_rules, fix_command, python_program


@dataclass
class Check:
    id: str
    ok: bool
    level: str      # ok / warn / danger
    title: str
    detail: str = ""


def _udp_free(port: int) -> tuple[bool, str]:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind(("0.0.0.0", port))
        return True, ""
    except OSError as e:
        return False, str(e)
    finally:
        s.close()


def _tcp_free(host: str, port: int) -> tuple[bool, str]:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        return True, ""
    except OSError as e:
        return False, str(e)
    finally:
        s.close()


def local_ip_toward(host: str) -> str | None:
    """本機會用哪個 IP 送封包到 Tello（不會真的送出任何東西）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((socket.gethostbyname(host), 8889))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def firewall_checks() -> list[Check]:
    """原生模式（Windows）：找出封鎖這個 python.exe 入站連線的防火牆規則。"""
    rules = blocking_rules()
    if rules is None:
        return []
    prog = python_program()
    if not rules:
        return [Check("firewall", True, "ok", "Windows 防火牆沒有封鎖這個 Python", prog)]
    profiles = "、".join(sorted({r["profile"] for r in rules}))
    return [Check(
        "firewall", False, "danger",
        f"Windows 防火牆封鎖了這個 Python 的入站連線（{len(rules)} 條規則，{profiles}）",
        f"這會擋掉 Tello 的狀態（UDP 8890）與影像（UDP 11111），但指令回應仍收得到。"
        f"封鎖規則優先於允許規則，必須刪掉：以系統管理員開 PowerShell，在專案資料夾執行 "
        f"powershell -ExecutionPolicy Bypass -File scripts\\allow-firewall.ps1 ；"
        f"或直接執行：{fix_command(prog)}"
    )]


def run_checks(s: Settings, before_bind: bool = True) -> list[Check]:
    out: list[Check] = []
    v = sys.version_info
    out.append(Check("python", v >= (3, 10), "ok" if v >= (3, 10) else "danger",
                     f"Python {v.major}.{v.minor}.{v.micro}",
                     "" if v >= (3, 10) else "需要 Python 3.10 以上"))

    ff = shutil.which("ffmpeg")
    out.append(Check("ffmpeg", bool(ff), "ok" if ff else "warn",
                     "ffmpeg 已安裝" if ff else "找不到 ffmpeg",
                     "" if ff else "主要影像路徑（WebCodecs）不需要 ffmpeg；只有 MJPEG 備援會停用"))

    if before_bind:
        for port, name in ((s.state_port, "狀態"), (s.video_port, "影像")):
            ok, err = _udp_free(port)
            out.append(Check(f"udp{port}", ok, "ok" if ok else "danger",
                             f"UDP {port}（{name}）" + ("可用" if ok else "被占用"),
                             "" if ok else f"{err}。可能是 TelloFPV、另一個 gcs，或 Docker 容器還在跑"
                                           "（docker compose down）"))
        ok, err = _tcp_free(s.http_host, s.http_port)
        out.append(Check("http", ok, "ok" if ok else "danger",
                         f"HTTP {s.http_host}:{s.http_port} " + ("可用" if ok else "被占用"),
                         "" if ok else f"{err}。是不是已經開了一個（Docker 或另一個終端機）？"))

    if s.in_docker:
        out.append(Check("docker", True, "ok", "在 Docker 容器內執行",
                         "若收不到狀態／影像封包，改用原生模式（start-windows.bat / start-mac.command）"))
    elif s.sim:
        out.append(Check("net", True, "ok", "模擬器模式", f"目標 {s.tello_host}:{s.cmd_port}"))
    else:
        out.extend(firewall_checks())
        ip = local_ip_toward(s.tello_host)
        on_tello = bool(ip and ip.startswith("192.168.10."))
        out.append(Check("net", on_tello, "ok" if on_tello else "warn",
                         f"本機 IP {ip or '未知'}" + ("（在 Tello 網段）" if on_tello else ""),
                         "" if on_tello else "看起來沒有連上 TELLO-XXXXXX 的 Wi-Fi"))
    return out


def as_dicts(checks: list[Check]) -> list[dict]:
    return [asdict(c) for c in checks]


def print_checks(checks: list[Check]) -> None:
    mark = {"ok": "[ OK ]", "warn": "[警告]", "danger": "[錯誤]"}
    for c in checks:
        line = f"  {mark[c.level]} {c.title}"
        if c.detail:
            line += f" — {c.detail}"
        print(line, flush=True)
