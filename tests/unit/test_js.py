"""前端純邏輯（跟隨模式的追蹤、手勢、控制器）用 Node 內建的 test runner 測。沒有 Node 就跳過。"""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_js_unit():
    node = shutil.which("node")
    if not node:
        pytest.skip("找不到 Node.js（只影響前端純邏輯測試）")
    files = sorted(str(p) for p in (ROOT / "tests" / "js").glob("*.test.mjs"))
    r = subprocess.run([node, "--test", *files], cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
