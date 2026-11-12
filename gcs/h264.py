"""Tello H.264（UDP 11111）分片重組：封包 → NAL → access unit（Annex B）。

Tello 把 Annex B 位元流切成最多 1460 byte 的 UDP 封包；每一幀最後一個封包比較短。
  * NalSplitter：依 start code 切出 NAL；收到「短封包」時可以 flush 把尾巴的 NAL 也吐出來
  * AccessUnitAssembler：遇到 AUD/SEI/SPS/PPS、或 first_mb_in_slice == 0 的 slice 就切出新的 AU
  * 快取最新的 SPS/PPS；IDR 的 AU 裡沒有 SPS/PPS 就補在前面（讓中途加入的瀏覽器也能開始解碼）
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

START = b"\x00\x00\x00\x01"

NAL_SLICE = 1
NAL_IDR = 5
NAL_SEI = 6
NAL_SPS = 7
NAL_PPS = 8
NAL_AUD = 9


def nal_type(nal: bytes) -> int:
    return nal[0] & 0x1F if nal else -1


def unescape(data: bytes) -> bytes:
    """移除 emulation prevention byte（00 00 03 → 00 00）。"""
    out = bytearray()
    zeros = 0
    for b in data:
        if zeros >= 2 and b == 3:
            zeros = 0
            continue
        out.append(b)
        zeros = zeros + 1 if b == 0 else 0
    return bytes(out)


class _Bits:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def bit(self) -> int:
        i = self.pos >> 3
        if i >= len(self.data):
            raise EOFError
        b = (self.data[i] >> (7 - (self.pos & 7))) & 1
        self.pos += 1
        return b

    def ue(self) -> int:
        zeros = 0
        while self.bit() == 0:
            zeros += 1
            if zeros > 31:
                raise ValueError("bad exp-golomb")
        v = 0
        for _ in range(zeros):
            v = (v << 1) | self.bit()
        return (1 << zeros) - 1 + v


def first_mb_in_slice(nal: bytes) -> Optional[int]:
    try:
        return _Bits(unescape(nal[1:12])).ue()
    except (EOFError, ValueError):
        return None


def codec_string(sps: bytes) -> Optional[str]:
    """WebCodecs codec string：avc1.PPCCLL（profile_idc、constraint flags、level_idc）。"""
    if not sps or len(sps) < 4 or nal_type(sps) != NAL_SPS:
        return None
    return f"avc1.{sps[1]:02x}{sps[2]:02x}{sps[3]:02x}"


class NalSplitter:
    """位元組流 → NAL（不含 start code）。"""

    MAX_BUF = 4 * 1024 * 1024

    def __init__(self) -> None:
        self.buf = bytearray()
        self.scan = 0           # 下一次從哪裡開始找 start code
        self.in_nal = False     # buf[0] 是不是已經對齊在一個 start code 上

    @staticmethod
    def _find(buf: bytearray, start: int) -> tuple[int, int]:
        """回傳 (start code 起點, 長度)；找不到回傳 (-1, 0)。"""
        i = buf.find(b"\x00\x00\x01", start)
        if i < 0:
            return -1, 0
        if i > 0 and buf[i - 1] == 0:
            return i - 1, 4
        return i, 3

    def feed(self, data: bytes) -> list[bytes]:
        self.buf += data
        out: list[bytes] = []
        if not self.in_nal:
            i, n = self._find(self.buf, 0)
            if i < 0:
                # 沒有 start code：只保留最後 3 byte（可能是被切開的 start code）
                del self.buf[:-3]
                return out
            del self.buf[:i]
            self.in_nal = True
            self.scan = n
        hdr = 4 if self.buf[:4] == START else 3
        while True:
            j, n = self._find(self.buf, max(self.scan, hdr))
            if j < 0:
                self.scan = max(hdr, len(self.buf) - 3)
                break
            nal = bytes(self.buf[hdr:j])
            if nal:
                out.append(nal)
            del self.buf[:j]
            hdr = n
            self.scan = n
        if len(self.buf) > self.MAX_BUF:      # 壞資料保護
            self.reset()
        return out

    def flush(self) -> list[bytes]:
        """把目前累積的尾巴當成一個完整 NAL 吐出（收到短封包＝幀結束時呼叫）。"""
        if not self.in_nal:
            return []
        hdr = 4 if self.buf[:4] == START else 3
        nal = bytes(self.buf[hdr:])
        self.reset()
        return [nal] if nal else []

    def reset(self) -> None:
        self.buf = bytearray()
        self.scan = 0
        self.in_nal = False


@dataclass
class AccessUnit:
    key: bool
    data: bytes                     # Annex B（每個 NAL 前面都是 00 00 00 01）
    codec: Optional[str]
    types: list[int] = field(default_factory=list)
    patched: bool = False           # 是否補過 SPS/PPS


class AccessUnitAssembler:
    def __init__(self) -> None:
        self.sps: Optional[bytes] = None
        self.pps: Optional[bytes] = None
        self.cur: list[bytes] = []
        self.has_vcl = False

    def push(self, nal: bytes) -> list[AccessUnit]:
        out: list[AccessUnit] = []
        t = nal_type(nal)
        if t in (NAL_AUD, NAL_SEI, NAL_SPS, NAL_PPS) or 14 <= t <= 18:
            if self.has_vcl:
                out.append(self._close())
        elif t in (NAL_SLICE, NAL_IDR):
            if self.has_vcl and first_mb_in_slice(nal) == 0:
                out.append(self._close())
        if t == NAL_SPS:
            self.sps = nal
        elif t == NAL_PPS:
            self.pps = nal
        self.cur.append(nal)
        if t in (NAL_SLICE, NAL_IDR):
            self.has_vcl = True
        return out

    def flush(self) -> list[AccessUnit]:
        return [self._close()] if self.has_vcl else []

    def _close(self) -> AccessUnit:
        nals, self.cur, self.has_vcl = self.cur, [], False
        types = [nal_type(n) for n in nals]
        key = NAL_IDR in types
        patched = False
        if key and (NAL_SPS not in types or NAL_PPS not in types):
            aud = [n for n in nals if nal_type(n) == NAL_AUD]
            sps = [n for n in nals if nal_type(n) == NAL_SPS] or ([self.sps] if self.sps else [])
            pps = [n for n in nals if nal_type(n) == NAL_PPS] or ([self.pps] if self.pps else [])
            rest = [n for n in nals if nal_type(n) not in (NAL_AUD, NAL_SPS, NAL_PPS)]
            new = aud + sps + pps + rest
            patched = len(new) != len(nals)
            nals = new
            types = [nal_type(n) for n in nals]
        data = b"".join(START + n for n in nals)
        return AccessUnit(key=key, data=data, codec=codec_string(self.sps) if self.sps else None,
                          types=types, patched=patched)


class H264Reassembler:
    """封包進、AU 出。end_hint=True 表示這個封包是一幀的最後一個（短封包）。"""

    def __init__(self) -> None:
        self.splitter = NalSplitter()
        self.assembler = AccessUnitAssembler()

    def feed(self, packet: bytes, end_hint: bool = False) -> list[AccessUnit]:
        aus: list[AccessUnit] = []
        nals = self.splitter.feed(packet)
        if end_hint:
            nals += self.splitter.flush()
        for nal in nals:
            aus += self.assembler.push(nal)
        if end_hint:
            aus += self.assembler.flush()
        return aus
