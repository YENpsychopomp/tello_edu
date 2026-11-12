"""原生模式一鍵模擬：同時啟動模擬 Tello 與地面站（不需要 Docker、不需要無人機）。

    python -m sim.dev                 # http://localhost:8080
    python -m sim.dev --port 18080    # 換 port（避免跟 Docker 版衝突）
    python -m sim.dev --not-activated # 其他參數會轉給模擬器

模擬器與地面站都在 127.0.0.1，UDP 用 18889 / 18890 / 21111，不會跟真的 Tello 或 Docker 衝突。
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
from pathlib import Path

from .mock_tello import MockThread, parse_args

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    p = argparse.ArgumentParser(add_help=False)
    p.add_argument("--port", type=int, default=8080)
    known, rest = p.parse_known_args()
    opt = parse_args(["--host", "127.0.0.1", "--cmd-port", "18889", "--state-port", "18890",
                      "--video-port", "21111", *rest])
    mock = MockThread(opt).start()
    env = dict(os.environ, TELLO_IP="127.0.0.1", TELLO_CMD_PORT="18889", STATE_PORT="18890",
               VIDEO_PORT="21111", HTTP_PORT=str(known.port), TELLO_SIM="1", PYTHONUNBUFFERED="1")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    gcs = subprocess.Popen([sys.executable, "-m", "gcs"], cwd=ROOT, env=env, creationflags=flags)
    try:
        return gcs.wait()
    except KeyboardInterrupt:
        if os.name == "nt":
            gcs.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            gcs.send_signal(signal.SIGINT)
        try:
            return gcs.wait(10)
        except subprocess.TimeoutExpired:
            gcs.kill()
            return 1
    finally:
        mock.stop()


if __name__ == "__main__":
    sys.exit(main())
