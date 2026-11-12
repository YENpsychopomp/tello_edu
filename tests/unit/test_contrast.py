"""WCAG AA：tokens.css 裡用到的前景／背景組合對比度都要 ≥ 4.5:1。"""
import re
from pathlib import Path

import pytest

TOKENS = Path(__file__).resolve().parents[2] / "web" / "css" / "tokens.css"


def tokens() -> dict[str, str]:
    css = TOKENS.read_text(encoding="utf-8")
    return dict(re.findall(r"--([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;", css))


def lum(hex_: str) -> float:
    r, g, b = (int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5))
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio(a: str, b: str) -> float:
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


T = tokens()
TEXT = ["text", "text-2", "text-3", "accent", "ok", "warn", "danger"]
SURFACES = ["bg", "surface", "surface-2", "surface-3"]
PAIRS = [(fg, bg) for fg in TEXT for bg in SURFACES] + [
    ("ok", "ok-bg"), ("warn", "warn-bg"), ("danger", "danger-bg"), ("text", "danger-bg"),
    ("text", "warn-bg"), ("text", "ok-bg"), ("text-2", "danger-bg"),
    ("on-fill", "danger-fill"), ("on-warn", "warn"),
]


def test_background_not_pure_black():
    assert T["bg"].upper() == "#0B0F14"


@pytest.mark.parametrize("fg,bg", PAIRS)
def test_contrast_aa(fg, bg):
    r = ratio(T[fg], T[bg])
    assert r >= 4.5, f"{fg} {T[fg]} on {bg} {T[bg]} = {r:.2f}:1"
