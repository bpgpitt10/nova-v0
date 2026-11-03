"""GSPro's player box ("Shot 1   492.6 YDS"): the shot number and GSPro's own
straight distance to the pin, read from the same native window capture as wind.

Before the first shot GSPro writes no distance to its files, and the GKD lists
every pin slot but not the one in play; this number picks the slot exactly.
Read at a few sizes; values count only when two reads agree.
"""
from __future__ import annotations

import re

import cv2
import numpy as np

import gspro_native_wind_ocr as wind
import gspro_window_capture as capture
from open_golf_coach_helper import utc_now_iso

# Top-left player box, second line (FarmLinks 3776x2138 and 2000x1142 frames).
HUD_LINE = (0.008, 0.058, 0.15, 0.088)
HUD_TARGET_HEIGHTS = (40, 60, 80)
HUD_PAD_PX = 16
HUD_THRESHOLD = 170
HUD_WHITELIST = "0123456789.ShotYDSFT "
_PATTERN = re.compile(r"SHOT\s*(\d{1,2})\s+(\d{1,3}(?:\.\d)?)\s*Y", re.I)


def _unavailable(note: str) -> dict:
    return {"status": "UNAVAILABLE", "shotNumber": None, "distanceToPinYds": None,
            "observedAt": utc_now_iso(), "rawText": None, "note": note}


def _crop(report: dict):
    if report.get("status") != "captured" or not report.get("quality", {}).get("nonblank", False):
        return None
    try:
        width, height = int(report["windowWidth"]), int(report["windowHeight"])
        raw = report.get("_private_bgra")
        if width < 640 or height < 360 or width * height > capture.MAX_CAPTURE_PIXELS:
            return None
        if not isinstance(raw, bytes) or len(raw) != width * height * 4:
            return None
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)[:, :, :3]
        x1, y1, x2, y2 = HUD_LINE
        roi = frame[int(height * y1):int(height * y2), int(width * x1):int(width * x2)]
        return roi if roi.size else None
    except (ValueError, TypeError, KeyError):
        return None


def parse_hud_line(text: str):
    match = _PATTERN.search((text or "").replace(",", "."))
    if not match:
        return None
    shot, distance = int(match.group(1)), float(match.group(2))
    if not (1 <= shot <= 20 and 0 <= distance <= 800):
        return None
    return shot, distance


def read_hud_from_capture(report: dict) -> dict:
    roi = _crop(report)
    if roi is None:
        return _unavailable("GSPro window capture unavailable.")
    seen: dict[tuple, int] = {}
    texts = []
    for height in HUD_TARGET_HEIGHTS:
        try:
            scale = height / roi.shape[0]
            enlarged = cv2.resize(roi, None, fx=scale, fy=scale,
                                  interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
            b, g, red = cv2.split(enlarged)
            luminance = 0.0722 * b.astype(np.float32) + 0.7152 * g.astype(np.float32) + 0.2126 * red.astype(np.float32)
            binary = np.where(luminance >= HUD_THRESHOLD, 0, 255).astype(np.uint8)
            binary = cv2.copyMakeBorder(binary, HUD_PAD_PX, HUD_PAD_PX, HUD_PAD_PX, HUD_PAD_PX,
                                        cv2.BORDER_CONSTANT, value=255)
            ok, encoded = cv2.imencode(".png", binary)
        except cv2.error:
            continue
        if not ok:
            continue
        result = wind._ocr_png_with_tesseract(encoded.tobytes(), psm=7, whitelist=HUD_WHITELIST)
        if result.get("status") != "ok":
            return _unavailable(str(result.get("note") or "hud_ocr_failed")[:120])
        text = result.get("rawText") or ""
        texts.append(text)
        parsed = parse_hud_line(text)
        if parsed is None:
            continue
        seen[parsed] = seen.get(parsed, 0) + 1
        if seen[parsed] >= 2:
            return {"status": "READY", "shotNumber": parsed[0], "distanceToPinYds": parsed[1],
                    "observedAt": utc_now_iso(), "rawText": " / ".join(texts),
                    "note": "GSPro player box: shot number and distance to pin."}
    return {"status": "UNKNOWN", "shotNumber": None, "distanceToPinYds": None,
            "observedAt": utc_now_iso(), "rawText": " / ".join(texts) or None,
            "note": "GSPro player box not read consistently."}
