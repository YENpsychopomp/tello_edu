"""飛行紀錄（黑盒子）：起降切趟、摘要數值、CSV／JSON 匯出、環形緩衝。"""
import csv
import io

from gcs.flightlog import CSV_HEADER, END_GRACE, FlightLog, filename


def st(**kw):
    base = dict(bat=80, h=0, tof=10, pitch=0, roll=0, yaw=0, vgx=0, vgy=0, vgz=0, templ=50, temph=52,
                baro=100.0, time=0, mid=-1, x=-100, y=-100, z=-100)
    base.update(kw)
    return base


def fly(log, t0, dur, bat0=80, bat1=70, h=120, vgx=10, step=0.1):
    """從 t0 飛 dur 秒再落地，回傳落地後的時間。"""
    t = t0
    n = int(dur / step)
    for i in range(n):
        bat = round(bat0 + (bat1 - bat0) * i / max(1, n - 1))
        log.sample(st(bat=bat, h=h, vgx=vgx, vgy=0), (0, 50, 0, 0), True, now=t)
        t += step
    # 落地：遙測顯示不在空中
    for _ in range(int(END_GRACE / step) + 3):
        log.sample(st(bat=bat1, h=0), (0, 0, 0, 0), False, now=t)
        t += step
    return t


def test_flight_detected_and_summarised():
    ended = []
    log = FlightLog(clock=lambda: 0.0, wall=lambda: 1_700_000_000.0, on_flight_end=ended.append)
    log.sample(st(), (0, 0, 0, 0), False, now=0.0)
    assert log.current is None and not log.flights
    fly(log, 1.0, 30.0, bat0=80, bat1=74, h=150, vgx=10)       # 10 dm/s = 1 m/s，30 秒 → 約 30 m
    assert len(log.flights) == 1 and len(ended) == 1
    f = log.flights[0]
    assert f.n == 1 and f.done
    assert abs(f.duration() - 30.0) < 0.3
    assert f.max_h == 150
    assert f.bat0 == 80 and f.bat1 == 74
    assert abs(f.max_speed - 1.0) < 1e-9
    assert 28 < f.distance < 31
    d = f.to_dict()
    assert d["bat_used"] == 6 and d["duration_s"] == 30.0 and d["done"] is True
    txt = f.summary_text()
    assert "第 1 趟" in txt and "1.5 m" in txt and "1.0 m/s" in txt and "用電 6%" in txt and "30 m" in txt


def test_short_dropout_does_not_split_flight():
    log = FlightLog(clock=lambda: 0.0)
    t = 0.0
    for _ in range(20):
        log.sample(st(h=100), (0, 0, 0, 0), True, now=t); t += 0.1
    for _ in range(5):                                   # 0.5 秒遙測顯示不在空中（< END_GRACE）
        log.sample(st(h=0), (0, 0, 0, 0), False, now=t); t += 0.1
    for _ in range(20):
        log.sample(st(h=100), (0, 0, 0, 0), True, now=t); t += 0.1
    assert log.current is not None and not log.flights
    for _ in range(int(END_GRACE * 10) + 2):
        log.sample(st(h=0), (0, 0, 0, 0), False, now=t); t += 0.1
    assert len(log.flights) == 1
    f = log.flights[0]
    assert 4.3 < f.duration() < 4.7                      # 落地時間算到「開始不在空中」那一刻


def test_two_flights_numbered_and_filtered_export():
    log = FlightLog(clock=lambda: 0.0)
    t = fly(log, 0.0, 5.0)
    t = fly(log, t + 10.0, 8.0)
    assert [f.n for f in log.flights] == [1, 2]
    rows1 = log.rows(1)
    rows2 = log.rows(2)
    assert rows1 and rows2
    assert all(r[0] <= log.flights[0].t1 + 3.0 for r in rows1)
    assert all(r[0] >= log.flights[1].t0 - 3.0 for r in rows2)
    assert log.rows(99) == []
    assert len(log.rows()) == len(log.samples)
    j = log.to_json(2)
    assert j["flights"][0]["n"] == 2 and len(j["samples"]) == len(rows2)


def test_csv_shape_and_command_attached_to_next_sample():
    log = FlightLog(clock=lambda: 0.0)
    log.sample(st(), (0, 0, 0, 0), False, now=0.0)
    log.command("takeoff", "ok", now=0.5)
    log.sample(st(h=30), (0, 20, 0, 0), True, now=1.0)
    log.sample(st(h=60), (0, 20, 0, 0), True, now=1.1)
    rows = list(csv.reader(io.StringIO(log.to_csv())))
    assert tuple(rows[0]) == CSV_HEADER
    assert len(rows) == 4
    assert all(len(r) == len(CSV_HEADER) for r in rows[1:])
    ix = {k: i for i, k in enumerate(CSV_HEADER)}
    assert rows[2][ix["cmd"]] == "takeoff" and rows[2][ix["resp"]] == "ok"
    assert rows[3][ix["cmd"]] == ""                    # 只掛一筆
    assert rows[2][ix["rc_b"]] == "20" and rows[2][ix["flying"]] == "1" and rows[2][ix["flight"]] == "1"
    assert rows[1][ix["flight"]] == ""
    assert log.current.cmds == ["takeoff"]


def test_ring_buffer_and_status():
    log = FlightLog(clock=lambda: 0.0, max_samples=50)
    for i in range(80):
        log.sample(st(), (0, 0, 0, 0), False, now=i * 0.1)
    s = log.status()
    assert s["samples"] == 50 and s["total_samples"] == 80
    assert s["current"] is None and s["flights"] == []
    log.event("ok", "x", "hi", now=9.0)
    assert log.status()["events"] == 1


def test_status_during_flight_and_filename():
    log = FlightLog(clock=lambda: 12.0)
    for i in range(10):
        log.sample(st(h=80, bat=60), (0, 0, 0, 0), True, now=2.0 + i * 0.1)
    s = log.status(now=12.0)
    assert s["current"]["n"] == 1 and s["current"]["done"] is False and s["current"]["duration_s"] == 10.0
    assert log.flight(1) is log.current
    assert filename("tello-flightlog", 3, "csv", 0).endswith("-flight3.csv")
    assert filename("tello-flightlog", None, "json", 0).endswith(".json") and "flight" not in filename("x", None, "csv", 0)
