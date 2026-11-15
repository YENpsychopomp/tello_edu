"""飛行紀錄 API：/api/flights、/api/flightlog.csv、/api/flightlog.json；link 起降後有 flight_done 事件。"""
import asyncio
import csv
import io

import pytest
from fastapi.testclient import TestClient

from gcs.config import Settings
from gcs.flightlog import CSV_HEADER
from gcs.link import TelloLink
from gcs.server import create_app
from sim.mock_tello import MockTello, Options


@pytest.fixture()
def client():
    s = Settings(tello_host="127.0.0.1", cmd_port=9, state_port=0, video_port=0, http_port=8080,
                 public_port=8080, sim=True, extra_origins="")
    with TestClient(create_app(s)) as c:
        yield c


def test_flight_endpoints_empty(client):
    j = client.get("/api/flights").json()
    assert j["flights"] == [] and j["current"] is None and j["samples"] == 0
    r = client.get("/api/flightlog.csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment; filename=\"tello-flightlog-" in r.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(r.text)))
    assert tuple(rows[0]) == CSV_HEADER and len(rows) == 1
    r = client.get("/api/flightlog.csv?flight=3")
    assert r.headers["content-disposition"].endswith('-flight3.csv"')
    j = client.get("/api/flightlog.json?flight=1").json()
    assert j["header"] == list(CSV_HEADER) and j["samples"] == [] and j["flights"] == []


def test_flight_recorded_end_to_end_with_mock():
    async def go():
        mock = MockTello(Options(host="127.0.0.1", cmd_port=0, state_port=0, video=False, quiet=True,
                                 takeoff_delay=0.2))
        await mock.start()
        s = Settings(tello_host="127.0.0.1", cmd_port=mock.cmd_port_bound, state_port=0, video_port=0, sim=True)
        events = []
        link = TelloLink(s, wifi_poll=999, wifi_first=999, on_event=lambda lv, code, msg: events.append(code))
        ended = []
        link.flightlog.on_flight_end = ended.append
        await link.start()
        mock.o.state_port = link.state_port_bound
        for _ in range(150):
            if link.connected():
                break
            await asyncio.sleep(0.02)
        assert link.connected()
        assert await link.command("takeoff") == "ok"
        # 餵 rc 讓它不會被斷訊保護降落；往前飛 1 秒
        for _ in range(30):
            link.set_rc((0, 40, 0, 0))
            await asyncio.sleep(0.033)
        assert link.flightlog.current is not None and link.flightlog.current.n == 1
        assert link.telemetry()["flight_n"] == 1
        link.immediate("land")
        for _ in range(300):
            if ended:
                break
            link.set_rc((0, 0, 0, 0))
            await asyncio.sleep(0.03)
        assert ended and ended[0].n == 1 and ended[0].done
        f = ended[0]
        assert f.max_h > 0 and f.max_speed > 0 and "takeoff" in f.cmds and "land" in f.cmds
        csv_text = link.flightlog.to_csv(1)
        ix = {k: i for i, k in enumerate(CSV_HEADER)}
        rows = list(csv.reader(io.StringIO(csv_text)))[1:]
        cmds = [r[ix["cmd"]] for r in rows]
        assert "takeoff" in cmds and "land" in cmds
        assert any(r[ix["rc_b"]] == "40" for r in rows)
        assert link.flightlog.status()["flights"][0]["n"] == 1
        await link.shutdown()
        await mock.stop()
    asyncio.run(go())
