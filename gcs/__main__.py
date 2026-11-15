"""python -m gcs —— 啟動檢查 → uvicorn。

收到 SIGINT / SIGTERM / SIGBREAK（Ctrl+C、docker stop、關閉 Windows 主控台）時：
  1. 立刻送 land（如果在空中）—— 不等 uvicorn 關閉連線
  2. uvicorn 優雅關閉（最多等 2 秒）
  3. lifespan 收尾：再送一次 land（若仍在空中），然後關閉 UDP socket
"""
from __future__ import annotations

import asyncio
import logging
import sys

import uvicorn

from . import __version__
from .config import Settings
from .preflight import print_checks, run_checks
from .server import create_app


class GcsServer(uvicorn.Server):
    def __init__(self, config: uvicorn.Config, app):
        super().__init__(config)
        self.gcs_app = app
        self.loop: asyncio.AbstractEventLoop | None = None

    def handle_exit(self, sig, frame) -> None:  # 在主執行緒的 signal handler 裡執行
        link = getattr(self.gcs_app.state, "link", None)
        if link is not None and self.loop is not None and not self.should_exit:
            self.loop.call_soon_threadsafe(_land_on_exit, link)
        super().handle_exit(sig, frame)

    async def serve(self, sockets=None) -> None:
        self.loop = asyncio.get_running_loop()
        await super().serve(sockets)


def _land_on_exit(link) -> None:
    if link.flying():
        logging.getLogger("gcs").warning("收到結束訊號，無人機在空中 → 立即送出降落")
        link.send("land")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s", datefmt="%H:%M:%S")
    for name in ("uvicorn.access",):
        logging.getLogger(name).setLevel(logging.WARNING)
    s = Settings()
    print(f"Tello 地面站 v{__version__}", flush=True)
    print("啟動檢查：", flush=True)
    checks = run_checks(s)
    print_checks(checks)
    fatal = [c for c in checks if c.level == "danger" and c.id != "firewall"]
    if any(c.id == "firewall" and not c.ok for c in checks):
        print("\n!!! Windows 防火牆會擋掉 Tello 的狀態與影像封包（畫面會停在「等待狀態封包」）。"
              "\n!!! 請照上面 [錯誤] 那一行的指令修正（需要系統管理員），再重新啟動。", flush=True)
    if fatal:
        print("\n有無法繼續的錯誤，請先排除上面標示 [錯誤] 的項目。", flush=True)
        return 2
    if s.sim:
        print("\n*** 模擬器模式：不會控制真的無人機 ***", flush=True)
    if s.in_docker:
        print(f"\n控制頁面：http://localhost:{s.public_port}  ← 用 Chrome 或 Edge 開（一定要用 localhost）",
              flush=True)
    else:
        print(f"\n控制頁面：http://localhost:{s.http_port}  ← 用 Chrome 或 Edge 開（一定要用 localhost）",
              flush=True)
    if s.lan:
        ips = s.lan_ips
        urls = "、".join(f"http://{ip}:{s.public_port}" for ip in ips) or "（找不到這台電腦的 IP）"
        print(f"手機／平板（連同一個 Wi-Fi）：{urls}", flush=True)
        print("    LAN 模式：同一個 Wi-Fi 上的任何裝置都能開控制頁（第一個開的是機長，其他要按「接管」）。"
              "Tello 的 Wi-Fi 預設沒有密碼，請只在可信任的環境使用。", flush=True)
        print("    用 IP 開的頁面不是 secure context：影像走 MJPEG（需要 ffmpeg）、不能用實體手把，改用觸控搖桿。", flush=True)
    print(f"Tello 位址：{s.tello_host}:{s.cmd_port}；Ctrl+C 結束（在空中會先降落）\n", flush=True)

    app = create_app(s, checks=checks)
    cfg = uvicorn.Config(app, host=s.http_host, port=s.http_port, log_level="warning",
                         timeout_graceful_shutdown=2, ws_ping_interval=5, ws_ping_timeout=5,
                         lifespan="on")
    server = GcsServer(cfg, app)
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
