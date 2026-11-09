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


# GSPro 4.0 (Nov 2026) player box, second line: "368.2 yd   ▼ 10ft 11   Tee   [1] 2 3 4".
# No "Shot N": the shot in play is the highlighted (white) cell. The elevation
# is feet and inches with a green ▼ (pin below) or ▲ (pin above).
# Brian's 4K Valhalla screenshot (8 Nov): line rows 0.050-0.083, box from x 0.005.
V4_REGION = (0.12, 0.25)  # top-left search area (height, width fractions)
V4_DIST = re.compile(r"(\d{1,3}(?:\.\d)?)\s*Y", re.I)
V4_ELEV = re.compile(r"(\d{1,3})\s*FT\s*(\d{1,2})?", re.I)


def _frame(report: dict):
    if report.get("status") != "captured" or not report.get("quality", {}).get("nonblank", False):
        return None
    try:
        width, height = int(report["windowWidth"]), int(report["windowHeight"])
        raw = report.get("_private_bgra")
        if width < 640 or height < 360 or width * height > capture.MAX_CAPTURE_PIXELS:
            return None
        if not isinstance(raw, bytes) or len(raw) != width * height * 4:
            return None
        return np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)[:, :, :3]
    except (ValueError, TypeError, KeyError):
        return None


def find_v4_player_line(frame: np.ndarray) -> dict | None:
    """Rows of the GSPro 4 player box's dark second line and its highlighted shot cell, or None."""
    height, width = frame.shape[:2]
    region = frame[:int(height * V4_REGION[0]), :int(width * V4_REGION[1])].astype(np.float32)
    lum = 0.0722 * region[:, :, 0] + 0.7152 * region[:, :, 1] + 0.2126 * region[:, :, 2]
    x0, x1 = int(width * 0.01), int(width * 0.15)
    dark_rows = np.nonzero((lum[:, x0:x1] < 60).mean(axis=1) > 0.6)[0]
    if len(dark_rows) < 6:
        return None
    # The longest run of dark rows is the line.
    runs, start = [], dark_rows[0]
    for a, b in zip(dark_rows, dark_rows[1:]):
        if b != a + 1:
            runs.append((start, a))
            start = b
    runs.append((start, dark_rows[-1]))
    top, bottom = max(runs, key=lambda r: r[1] - r[0])
    bottom += 1
    if bottom - top < 0.015 * height:
        return None
    band = lum[top:bottom]
    dark_cols = np.nonzero((band < 60).mean(axis=0) > 0.5)[0]
    if len(dark_cols) == 0:
        return None
    left = int(dark_cols[0])
    # The highlighted cell is white; its digit breaks up the white, so the
    # cell runs to the last white column within about a cell's width.
    white = (band > 200).mean(axis=0)
    cells = np.nonzero(white > 0.8)[0]
    cells = cells[cells > left + 0.08 * width]
    if len(cells) == 0:
        return None
    cell_left = int(cells[0])
    near = cells[cells <= cell_left + 1.3 * (bottom - top)]
    cell_right = int(near[-1])
    if not (0.4 * (bottom - top) <= cell_right - cell_left + 1 <= 1.2 * (bottom - top)):
        return None
    return {"top": int(top), "bottom": int(bottom), "left": left,
            "cell": (cell_left, int(cell_right) + 1)}


def _ocr_crop(roi: np.ndarray, height: int, *, dark_text: bool, psm: int, whitelist: str) -> dict:
    scale = height / max(1, roi.shape[0])
    enlarged = cv2.resize(roi, None, fx=scale, fy=scale,
                          interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
    b, g, red = cv2.split(enlarged)
    luminance = 0.0722 * b.astype(np.float32) + 0.7152 * g.astype(np.float32) + 0.2126 * red.astype(np.float32)
    ink = luminance < 110 if dark_text else luminance >= HUD_THRESHOLD
    binary = np.where(ink, 0, 255).astype(np.uint8)
    binary = cv2.copyMakeBorder(binary, HUD_PAD_PX, HUD_PAD_PX, HUD_PAD_PX, HUD_PAD_PX,
                                cv2.BORDER_CONSTANT, value=255)
    ok, encoded = cv2.imencode(".png", binary)
    if not ok:
        return {"status": "error"}
    return wind._ocr_png_with_tesseract(encoded.tobytes(), psm=psm, whitelist=whitelist)


def _elevation_sign(roi: np.ndarray) -> int | None:
    """-1 for the ▼ (pin below), +1 for ▲, from where the coloured triangle is widest."""
    b, g, red = (roi[:, :, i].astype(np.int32) for i in range(3))
    colored = ((g - np.maximum(b, red) > 60) | (red - np.maximum(b, g) > 60))
    ys, xs = np.nonzero(colored)
    if len(xs) < 10:
        return None
    width_by_row = np.bincount(ys - ys.min())
    rows = np.nonzero(width_by_row)[0]
    if len(rows) < 3:
        return None
    upper = width_by_row[rows[: len(rows) // 2]].mean()
    lower = width_by_row[rows[len(rows) - len(rows) // 2:]].mean()
    return -1 if upper > lower else 1


def read_v4_hud(report: dict) -> dict | None:
    frame = _frame(report)
    if frame is None:
        return None
    line = find_v4_player_line(frame)
    if line is None:
        return None
    top, bottom, left = line["top"], line["bottom"], line["left"]
    cell_left, cell_right = line["cell"]
    span = cell_left - left
    pad = max(1, (bottom - top) // 6)
    rows = frame[top + pad:bottom - pad]
    distance_roi = rows[:, left:left + int(span * 0.27)]
    elevation_roi = rows[:, left + int(span * 0.27):left + int(span * 0.56)]
    cell_roi = frame[top + pad:bottom - pad, cell_left + 2:cell_right - 2]
    votes: dict[str, dict] = {"distance": {}, "shot": {}, "elevation": {}}
    texts: list[str] = []

    def vote(kind, value):
        if value is not None:
            votes[kind][value] = votes[kind].get(value, 0) + 1

    for height in HUD_TARGET_HEIGHTS:
        d = _ocr_crop(distance_roi, height, dark_text=False, psm=7, whitelist="0123456789.yd ")
        if d.get("status") != "ok":
            return None if not texts else _unavailable(str(d.get("note") or "hud_ocr_failed")[:120])
        match = V4_DIST.search((d.get("rawText") or "").replace(",", "."))
        distance = float(match.group(1)) if match and 0 < float(match.group(1)) <= 800 else None
        vote("distance", distance)
        c = _ocr_crop(cell_roi, height, dark_text=True, psm=8, whitelist="0123456789")
        digits = re.sub(r"\D", "", c.get("rawText") or "") if c.get("status") == "ok" else ""
        shot = int(digits) if digits and 1 <= int(digits) <= 20 else None
        vote("shot", shot)
        e = _ocr_crop(elevation_roi, height, dark_text=False, psm=7, whitelist="0123456789ft ")
        em = V4_ELEV.search(e.get("rawText") or "") if e.get("status") == "ok" else None
        feet = round(int(em.group(1)) + (int(em.group(2)) / 12 if em.group(2) else 0), 2) if em else None
        vote("elevation", feet)
        texts.append(f"{(d.get('rawText') or '').strip()} | {(e.get('rawText') or '').strip()} | shot {digits or '-'}")
    agreed = {k: next((v for v, n in sorted(vs.items(), key=lambda kv: -kv[1]) if n >= 2), None)
              for k, vs in votes.items()}
    sign = _elevation_sign(elevation_roi)
    elevation = agreed["elevation"] * sign if agreed["elevation"] is not None and sign is not None else None
    ready = agreed["distance"] is not None and agreed["shot"] is not None
    return {"status": "READY" if ready else "UNKNOWN",
            "shotNumber": agreed["shot"], "distanceToPinYds": agreed["distance"],
            "elevationFt": elevation, "hudLayout": "gspro-4",
            "observedAt": utc_now_iso(), "rawText": " / ".join(texts),
            "note": "GSPro 4 player box: highlighted shot, distance to pin, pin height."
                    if ready else "GSPro 4 player box not read consistently."}


def read_hud_from_capture(report: dict) -> dict:
    v4 = read_v4_hud(report)
    if v4 is not None and v4.get("status") == "READY":
        return v4
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
    if v4 is not None:
        return v4
    return {"status": "UNKNOWN", "shotNumber": None, "distanceToPinYds": None,
            "observedAt": utc_now_iso(), "rawText": " / ".join(texts) or None,
            "note": "GSPro player box not read consistently."}
