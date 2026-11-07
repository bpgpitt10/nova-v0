"""GSPro's player box ("Shot 1   492.6 YDS   ▼ 4FT 11"): the shot number, GSPro's
own straight distance to the pin, and the height of the pin against the ball,
read from the same native window capture as wind.

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
# After "YDS": the arrow (read as Y/V/v or nothing), then feet and inches: "4FT 11", "2FT9", "12FT".
_ELEVATION = re.compile(r"YDS?\S*?\s*[YVv7]?\s*(\d{1,3})\s*F\s*T\s*(\d{1,2})?", re.I)
# The arrow is the one strongly coloured mark in the line (green ▼ downhill in
# the FarmLinks captures). Its direction comes from its shape, not its colour:
# a ▼ is widest at the top.
ARROW_MIN_SATURATION = 90
ARROW_MIN_VALUE = 110
ARROW_MIN_AREA_FRACTION = 0.004


def _unavailable(note: str) -> dict:
    return {"status": "UNAVAILABLE", "shotNumber": None, "distanceToPinYds": None,
            "elevationFt": None, "observedAt": utc_now_iso(), "rawText": None, "note": note}


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


def parse_hud_elevation(text: str):
    """Feet of height between ball and pin, unsigned ("4FT 11" -> 4.92), or None."""
    match = _ELEVATION.search((text or "").replace(",", "."))
    if not match:
        return None
    feet = int(match.group(1))
    inches = int(match.group(2)) if match.group(2) else 0
    if feet > 300 or inches > 11:
        return None
    return round(feet + inches / 12.0, 2)


def arrow_direction(roi) -> str | None:
    """'down' for ▼, 'up' for ▲, None when there is no clear coloured arrow."""
    try:
        pixels = roi.astype(np.int16)
        saturation = pixels.max(axis=2) - pixels.min(axis=2)
        value = pixels.max(axis=2)
        mask = ((saturation >= ARROW_MIN_SATURATION) & (value >= ARROW_MIN_VALUE)).astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    except (cv2.error, ValueError, AttributeError):
        return None
    if count <= 1:
        return None
    # The arrow is a filled triangle (fills about half its box) clear of the
    # crop's edges; GSPro's coloured score box, if the crop catches it, is a
    # nearly full rectangle at the edge.
    min_area = max(12, ARROW_MIN_AREA_FRACTION * roi.shape[0] * roi.shape[1] * 0.25)
    best, best_score = None, None
    for label in range(1, count):
        x, y, w, h, area = (int(stats[label, k]) for k in (cv2.CC_STAT_LEFT, cv2.CC_STAT_TOP,
                                                           cv2.CC_STAT_WIDTH, cv2.CC_STAT_HEIGHT,
                                                           cv2.CC_STAT_AREA))
        if area < min_area or h < 4 or w < 4:
            continue
        if x == 0 or x + w >= roi.shape[1]:
            continue
        fill = area / float(w * h)
        if not 0.3 <= fill <= 0.75 or not 0.5 <= w / float(h) <= 2.0:
            continue
        score = abs(fill - 0.5)
        if best_score is None or score < best_score:
            best, best_score = (label, x, y, w, h), score
    if best is None:
        return None
    label, x, y, w, h = best
    blob = labels[y:y + h, x:x + w] == label
    widths = blob.sum(axis=1)
    quarter = max(1, h // 4)
    top, bottom = float(widths[:quarter].mean()), float(widths[-quarter:].mean())
    if top > bottom * 1.6:
        return "down"
    if bottom > top * 1.6:
        return "up"
    return None


def read_hud_from_capture(report: dict) -> dict:
    roi = _crop(report)
    if roi is None:
        return _unavailable("GSPro window capture unavailable.")
    seen: dict[tuple, int] = {}
    elevations: dict[float, int] = {}
    texts = []
    direction = arrow_direction(roi)
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
        magnitude = parse_hud_elevation(text)
        if magnitude is not None:
            elevations[magnitude] = elevations.get(magnitude, 0) + 1
        parsed = parse_hud_line(text)
        if parsed is None:
            continue
        seen[parsed] = seen.get(parsed, 0) + 1
        if seen[parsed] >= 2:
            # Elevation needs two agreeing reads and a clear arrow (level: 0 ft, no arrow needed).
            agreed = next((m for m, n in elevations.items() if n >= 2), None)
            elevation_ft = None
            if agreed is not None:
                if agreed == 0:
                    elevation_ft = 0.0
                elif direction is not None:
                    elevation_ft = agreed if direction == "up" else -agreed
            return {"status": "READY", "shotNumber": parsed[0], "distanceToPinYds": parsed[1],
                    "elevationFt": elevation_ft, "elevationArrow": direction,
                    "observedAt": utc_now_iso(), "rawText": " / ".join(texts),
                    "note": "GSPro player box: shot number, distance to pin and pin height."}
    return {"status": "UNKNOWN", "shotNumber": None, "distanceToPinYds": None, "elevationFt": None,
            "observedAt": utc_now_iso(), "rawText": " / ".join(texts) or None,
            "note": "GSPro player box not read consistently."}
