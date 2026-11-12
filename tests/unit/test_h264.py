"""H.264 分片重組：start code 切割、AU 切分、SPS/PPS 補齊、codec string。"""
import random
import shutil
import subprocess

import pytest

from gcs.h264 import (START, AccessUnitAssembler, H264Reassembler, NalSplitter, codec_string,
                      first_mb_in_slice, nal_type, unescape)

SPS = bytes([0x67, 0x4D, 0x40, 0x1F, 0xE8, 0x80, 0x3C, 0x01, 0x13, 0xF2, 0xE0, 0x22, 0x00, 0x00, 0x03, 0x00, 0x02])
PPS = bytes([0x68, 0xEE, 0x3C, 0x80])
AUD = bytes([0x09, 0xF0])


def slice_nal(idr: bool, first_mb: int, size: int, seed: int) -> bytes:
    """first_mb_in_slice 以 exp-Golomb 編在 header 後；內容隨機但不含 00 00 0x（模擬 emulation prevention 後的資料）。"""
    hdr = 0x65 if idr else 0x41
    # ue(v)：first_mb=0 → '1'；first_mb=k → (zeros)1(bits)
    v = first_mb + 1
    nbits = v.bit_length()
    bits = "0" * (nbits - 1) + format(v, "b")
    bits += "1" * ((8 - len(bits) % 8) % 8 or 8)
    head = int(bits, 2).to_bytes(len(bits) // 8, "big")
    rnd = random.Random(seed)
    body = bytearray()
    while len(body) < size:
        b = rnd.randrange(1, 256)          # 不產生 0x00，確保不會出現假的 start code
        body.append(b)
    return bytes([hdr]) + head + bytes(body)


def annexb(nals, four=True):
    return b"".join((START if four else b"\x00\x00\x01") + n for n in nals)


def packetize(stream: bytes, size=1460):
    return [stream[i:i + size] for i in range(0, len(stream), size)]


# ---------------------------------------------------------------- 基本工具
def test_codec_string_from_sps():
    assert codec_string(SPS) == "avc1.4d401f"
    assert codec_string(PPS) is None
    assert codec_string(b"") is None


def test_first_mb_parse():
    assert first_mb_in_slice(slice_nal(True, 0, 10, 1)) == 0
    assert first_mb_in_slice(slice_nal(False, 1, 10, 1)) == 1
    assert first_mb_in_slice(slice_nal(False, 600, 10, 1)) == 600


def test_unescape_emulation_prevention():
    assert unescape(b"\x00\x00\x03\x01\x00\x00\x03\x00") == b"\x00\x00\x01\x00\x00\x00"


# ---------------------------------------------------------------- NAL 切割
@pytest.mark.parametrize("four", [True, False])
def test_splitter_reassembles_across_random_packet_boundaries(four):
    nals = [SPS, PPS, slice_nal(True, 0, 9000, 1), slice_nal(False, 0, 700, 2), slice_nal(False, 0, 3000, 3), AUD]
    stream = annexb(nals, four) + START      # 最後補一個 start code 讓最後一個 NAL 結束
    rnd = random.Random(42)
    for _ in range(30):
        sp = NalSplitter()
        got = []
        i = 0
        while i < len(stream):
            n = rnd.randint(1, 2000)
            got += sp.feed(stream[i:i + n])
            i += n
        assert got == nals


def test_splitter_split_inside_start_code():
    sp = NalSplitter()
    a, b = slice_nal(True, 0, 50, 1), slice_nal(False, 0, 50, 2)
    stream = START + a + START + b + START
    out = []
    # 把 start code 從中間切開：... 00 | 00 00 01 ...
    cut = len(START + a) + 1
    out += sp.feed(stream[:cut])
    out += sp.feed(stream[cut:cut + 2])
    out += sp.feed(stream[cut + 2:])
    assert out == [a, b]


def test_splitter_drops_leading_garbage_and_flushes_tail():
    sp = NalSplitter()
    a = slice_nal(True, 0, 100, 1)
    assert sp.feed(b"\x12\x34\x56" + START + a) == []
    assert sp.flush() == [a]
    assert sp.flush() == []


# ---------------------------------------------------------------- AU 組裝
def test_au_grouping_with_multiple_slices_per_frame():
    asm = AccessUnitAssembler()
    nals = [SPS, PPS,
            slice_nal(True, 0, 100, 1), slice_nal(True, 300, 100, 2),          # 一個 IDR 幀 2 個 slice
            slice_nal(False, 0, 100, 3), slice_nal(False, 300, 100, 4),        # P 幀 2 個 slice
            slice_nal(False, 0, 100, 5)]                                        # 下一個 P 幀
    aus = []
    for n in nals:
        aus += asm.push(n)
    aus += asm.flush()
    assert [au.key for au in aus] == [True, False, False]
    assert aus[0].types == [7, 8, 5, 5]
    assert aus[1].types == [1, 1]
    assert aus[2].types == [1]
    assert all(au.codec == "avc1.4d401f" for au in aus)
    assert aus[0].data.startswith(START + SPS)


def test_idr_without_sps_pps_gets_cached_ones_prepended():
    asm = AccessUnitAssembler()
    aus = []
    for n in [AUD, SPS, PPS, slice_nal(True, 0, 50, 1),
              AUD, slice_nal(False, 0, 50, 2),
              AUD, slice_nal(True, 0, 50, 3)]:        # 第二個 IDR 沒帶 SPS/PPS
        aus += asm.push(n)
    aus += asm.flush()
    assert [a.key for a in aus] == [True, False, True]
    assert not aus[0].patched
    assert aus[2].patched
    assert aus[2].types == [9, 7, 8, 5]               # AUD 之後補上 SPS、PPS
    assert aus[2].data.startswith(START + AUD + START + SPS + START + PPS + START)


def test_idr_with_only_pps_gets_sps():
    asm = AccessUnitAssembler()
    for n in [SPS, PPS, slice_nal(True, 0, 50, 1)]:
        asm.push(n)
    asm.flush()
    aus = []
    for n in [PPS, slice_nal(True, 0, 50, 2)]:
        aus += asm.push(n)
    aus += asm.flush()
    assert aus[0].types == [7, 8, 5]


def test_reassembler_with_tello_style_packets_and_end_hint():
    frames = [[SPS, PPS, slice_nal(True, 0, 6000, 1)]] + [[slice_nal(False, 0, 1500 + i * 37, 10 + i)] for i in range(10)]
    rx = H264Reassembler()
    aus = []
    for f in frames:
        pkts = packetize(annexb(f))
        if len(pkts[-1]) == 1460:          # 確保每幀最後一個封包是短封包（Tello 的行為）
            pkts.append(b"")
        for i, p in enumerate(pkts):
            if p:
                aus += rx.feed(p, end_hint=len(p) < 1460)
    assert len(aus) == len(frames)                  # 每幀立刻吐出，不必等下一幀
    assert aus[0].key and not any(a.key for a in aus[1:])
    for au, f in zip(aus, frames):
        assert au.data == annexb(f)


def test_nal_type():
    assert nal_type(SPS) == 7 and nal_type(PPS) == 8 and nal_type(b"") == -1


# ---------------------------------------------------------------- 真實 x264 串流（有 ffmpeg 才跑）
@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="需要 ffmpeg")
def test_real_x264_stream_frame_count():
    n_frames = 45
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=960x720:rate=30",
           "-frames:v", str(n_frames), "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
           "-g", "15", "-bf", "0", "-f", "h264", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    # 模擬 Tello：只有串流開頭帶 SPS/PPS，後面的 IDR 不帶
    sp = NalSplitter()
    nals = sp.feed(raw) + sp.flush()
    seen: set[int] = set()
    kept = []
    for n in nals:
        t = nal_type(n)
        if t in (7, 8) and t in seen:
            continue
        seen.add(t)
        kept.append(n)
    stream = annexb(kept)
    rx = H264Reassembler()
    aus = []
    for p in packetize(stream):                      # 沒有 end hint：純靠 start code 與 first_mb
        aus += rx.feed(p)
    tail = rx.splitter.flush()
    for n in tail:
        aus += rx.assembler.push(n)
    aus += rx.assembler.flush()
    assert len(aus) == n_frames
    keys = [i for i, a in enumerate(aus) if a.key]
    assert keys == [0, 15, 30]
    assert all(a.codec and a.codec.startswith("avc1.") for a in aus)
    # x264 只在開頭帶 SPS/PPS → 後面的 IDR 必須被補上
    assert all(7 in aus[i].types and 8 in aus[i].types for i in keys)
    assert aus[15].patched and aus[30].patched
