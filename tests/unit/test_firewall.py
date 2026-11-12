"""Windows 防火牆封鎖規則偵測（「有指令回應、收不到狀態封包」最常見的原因）。"""
import os

import pytest

from gcs import firewall, preflight


def test_block_rules_reported_as_error_with_fix(monkeypatch):
    monkeypatch.setattr(preflight, "blocking_rules", lambda: [{"name": "Python", "profile": "Public"},
                                                            {"name": "Python", "profile": "Public"}])
    monkeypatch.setattr(preflight, "python_program", lambda: r"C:\Python314\python.exe")
    [c] = preflight.firewall_checks()
    assert c.id == "firewall" and not c.ok and c.level == "danger"
    assert "2 條規則" in c.title and "Public" in c.title
    assert "allow-firewall.ps1" in c.detail and r"C:\Python314\python.exe" in c.detail
    assert "Remove-NetFirewallRule" in c.detail


def test_no_block_rules_is_ok(monkeypatch):
    monkeypatch.setattr(preflight, "blocking_rules", lambda: [])
    [c] = preflight.firewall_checks()
    assert c.ok and c.level == "ok"


def test_unknown_platform_skips(monkeypatch):
    monkeypatch.setattr(preflight, "blocking_rules", lambda: None)
    assert preflight.firewall_checks() == []


@pytest.mark.skipif(os.name != "nt", reason="只在 Windows 查詢防火牆")
def test_real_query_runs():
    rules = firewall.blocking_rules()
    assert rules is None or isinstance(rules, list)
