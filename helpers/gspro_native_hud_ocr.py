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

# GSPro 4.0 (Nov 2026) player box, second line: "368.2 yd   ▼ 10ft 11   Tee   [1] 2 3 4".
# No "Shot N": the shot in play is the highlighted (white) cell. The elevation
# is feet and inches with a green ▼ (pin below) or ▲ (pin above).
# Brian's 4K Valhalla screenshot (8 Nov): line rows 0.050-0.083, box from x 0.005.
V4_REGION = (0.12, 0.25)  # top-left search area (height, width fractions)
# GSPro 4 always shows a tenth ("465.9"); the "yd" can fall outside the crop.
V4_DIST = re.compile(r"(\d{1,3}\.\d)")
# Always feet and inches ("0ft 6"): a read that lost the inches doesn't count.
V4_ELEV = re.compile(r"(\d{1,3})\s*FT\s*(\d{1,2})\b", re.I)


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
    x0, x1 = int(width * 0.03), int(width * 0.10)
    # The name band above the line is red (any player colour with one strong
    # channel works the same way); the line is the dark run right under it.
    # Trees and window chrome are dark too, so the red band anchors it.
    cols = region[:, x0:x1]
    b, g, r = cols[:, :, 0], cols[:, :, 1], cols[:, :, 2]
    colored = ((np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)) > 90).mean(axis=1) > 0.6
    dark = (lum[:, x0:x1] < 60).mean(axis=1) > 0.6
    top = bottom = None
    name_rows = None
    y = 0
    rows = region.shape[0]
    while y < rows:
        if colored[y]:
            start = y
            while y < rows and colored[y]:
                y += 1
            if y - start >= 0.012 * height:
                d = y
                while d < rows and not dark[d] and d - y < 0.006 * height:
                    d += 1  # a thin anti-aliased edge between the bands
                if d < rows and dark[d]:
                    top = d
                    name_rows = (start, y)
                    break
        y += 1
    if top is None:
        return None
    # The box's left edge is where the name band's colour starts (dark trees
    # or a window edge left of the box would pass a darkness test).
    name = region[name_rows[0]:name_rows[1]]
    nb, ng, nr = name[:, :, 0], name[:, :, 1], name[:, :, 2]
    name_cols = np.nonzero(((np.maximum(np.maximum(nr, ng), nb) - np.minimum(np.minimum(nr, ng), nb)) > 90)
                           .mean(axis=0) > 0.6)[0]
    if len(name_cols) == 0:
        return None
    left = int(name_cols[0])
    # The highlighted shot cell is white from the line's top to its bottom, so
    # it gives the line's height too. Neither darkness (the line's own text
    # rows are light, trees under the box are dark) nor the name band (its
    # text can split it) measured that reliably (Valhalla, 8 Nov).
    # The cell sits a few pixels inside the line: probe below its top margin.
    probe_top = top + max(2, int(0.004 * height))
    probe = lum[probe_top:min(lum.shape[0], probe_top + max(3, int(0.01 * height)))]
    white = (probe > 200).mean(axis=0)
    cells = np.nonzero(white > 0.9)[0]
    cells = cells[cells > left + 0.08 * width]
    if len(cells) == 0:
        return None
    cell_left = int(cells[0])
    near = cells[cells <= cell_left + 0.05 * height]
    cell_right = int(near[-1])
    margin = lum[:, cell_left + 1:cell_left + 4]
    cell_top = top
    while cell_top < probe_top and (margin[cell_top] > 200).mean() <= 0.6:
        cell_top += 1
    bottom = probe_top
    while bottom < lum.shape[0] and (margin[bottom] > 200).mean() > 0.6:
        bottom += 1
    bottom += cell_top - top  # the same margin under the cell as above it
    line = bottom - top
    if line < 0.015 * height or not (0.4 * line <= cell_right - cell_left + 1 <= 1.2 * line):
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
    # The green/red triangle next to the height merges with a leading "0"
    # ("▼0ft 6" read as "ft6"): paint it out before reading the digits.
    elevation_text = elevation_roi.copy()
    eb, eg, er = (elevation_text[:, :, i].astype(np.int32) for i in range(3))
    elevation_text[(np.maximum(np.maximum(eb, eg), er) - np.minimum(np.minimum(eb, eg), er)) > 60] = (20, 20, 20)
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
        e = _ocr_crop(elevation_text, height, dark_text=False, psm=7, whitelist="0123456789ft ")
        em = V4_ELEV.search(e.get("rawText") or "") if e.get("status") == "ok" else None
        feet = round(int(em.group(1)) + int(em.group(2)) / 12, 2) if em else None
        vote("elevation", feet)
        texts.append(f"{(d.get('rawText') or '').strip()} | {(e.get('rawText') or '').strip()} | shot {digits or '-'}")
    if not any(n >= 2 for n in votes["elevation"].values()):
        # The small "0ft 6" reads unevenly: a few more sizes before giving up on it.
        for height in (50, 70, 90, 100):
            e = _ocr_crop(elevation_text, height, dark_text=False, psm=7, whitelist="0123456789ft ")
            em = V4_ELEV.search(e.get("rawText") or "") if e.get("status") == "ok" else None
            vote("elevation", round(int(em.group(1)) + int(em.group(2)) / 12, 2) if em else None)
            if any(n >= 2 for n in votes["elevation"].values()):
                break
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
    if v4 is not None:
        return v4
    fallback = _v4_from_fixed_line(report, texts)
    if fallback is not None:
        if fallback.get("status") != "READY":
            saved = _save_hud_diagnostic(report)
            if saved:
                fallback["note"] += f" Player box saved as {saved} in the companion's diagnostics folder."
        return fallback
    return {"status": "UNKNOWN", "shotNumber": None, "distanceToPinYds": None, "elevationFt": None,
            "observedAt": utc_now_iso(), "rawText": " / ".join(texts) or None,
            "note": "GSPro player box not read consistently."}


# GSPro 4 always shows feet and inches ("0ft 6", "10ft 11"); requiring both
# keeps "6 T" (the "Tee" after a lost "0ft") from reading as 6 ft.
V4_TEXT_ELEV = re.compile(r"(\d{1,3})\s*F?T\s*(\d{1,2})\b", re.I)


def _v4_from_fixed_line(report: dict, texts: list[str]) -> dict | None:
    """GSPro 4 box read through the old fixed crop, when the box finder missed it.

    On Brian's sim (8 Nov, companion 1.0.4) the live capture's box wasn't found
    while the fixed crop still read "368.20  10Ft 11 T": the distance and height
    come from that text, the shot from the white cell to its right."""
    if not texts or any("SHOT" in t.upper() for t in texts):
        return None
    frame = _frame(report)
    if frame is None:
        return None
    height, width = frame.shape[:2]
    _, y1, _, y2 = HUD_LINE
    top, bottom = int(height * y1), int(height * y2)
    rows = frame[top:bottom].astype(np.float32)
    lum = 0.0722 * rows[:, :, 0] + 0.7152 * rows[:, :, 1] + 0.2126 * rows[:, :, 2]
    lo, hi = int(width * 0.10), int(width * 0.25)
    white = (lum[:, lo:hi] > 200).mean(axis=0)
    cells = np.nonzero(white > 0.8)[0]
    shot = None
    if len(cells):
        cell_left = lo + int(cells[0])
        near = cells[cells <= cells[0] + 1.6 * (bottom - top)]
        cell_right = lo + int(near[-1]) + 1
        if cell_right - cell_left >= 0.4 * (bottom - top):
            votes: dict[int, int] = {}
            pad = max(1, (bottom - top) // 6)
            cell = frame[top + pad:bottom - pad, cell_left + 2:max(cell_left + 3, cell_right - 2)]
            for h in HUD_TARGET_HEIGHTS:
                r = _ocr_crop(cell, h, dark_text=True, psm=8, whitelist="0123456789")
                digits = re.sub(r"\D", "", r.get("rawText") or "") if r.get("status") == "ok" else ""
                if digits and 1 <= int(digits) <= 20:
                    votes[int(digits)] = votes.get(int(digits), 0) + 1
            agreed = [v for v, n in votes.items() if n >= 2]
            shot = agreed[0] if agreed else None
    distance_votes: dict[float, int] = {}
    elevation_votes: dict[float, int] = {}
    for text in texts:
        match = V4_DIST.search(text.replace(",", "."))
        if match and 0 < float(match.group(1)) <= 800:
            value = float(match.group(1))
            distance_votes[value] = distance_votes.get(value, 0) + 1
            em = V4_TEXT_ELEV.search(text[match.end():])
            if em:
                feet = round(int(em.group(1)) + int(em.group(2)) / 12, 2)
                elevation_votes[feet] = elevation_votes.get(feet, 0) + 1
    distance = next((v for v, n in distance_votes.items() if n >= 2), None)
    feet = next((v for v, n in elevation_votes.items() if n >= 2), None)
    x1, _, x2, _ = HUD_LINE
    sign = _elevation_sign(frame[top:bottom, int(width * x1):int(width * x2)])
    ready = distance is not None and shot is not None
    return {"status": "READY" if ready else "UNKNOWN",
            "shotNumber": shot, "distanceToPinYds": distance,
            "elevationFt": feet * sign if feet is not None and sign is not None else None,
            "hudLayout": "gspro-4", "hudReader": "fixed-line",
            "observedAt": utc_now_iso(), "rawText": " / ".join(texts) + f" | shot {shot if shot else '-'}",
            "note": "GSPro 4 player box via the fixed crop." if ready
                    else "GSPro 4 player box via the fixed crop: not read consistently."}


_last_hud_diagnostic_at = 0.0


def _save_hud_diagnostic(report: dict) -> str | None:
    """Keep GSPro's player box (top-left of the window only: HUD pixels, no
    paths) when it can't be read, at most one a minute, newest few kept."""
    global _last_hud_diagnostic_at
    import time
    folder = wind._diagnostics_dir()
    now = time.monotonic()
    if folder is None or now - _last_hud_diagnostic_at < 60:
        return None
    frame = _frame(report)
    if frame is None:
        return None
    try:
        height, width = frame.shape[:2]
        box = frame[0:int(height * 0.12), 0:int(width * 0.25)]
        folder.mkdir(parents=True, exist_ok=True)
        name = time.strftime("hud-%Y%m%d-%H%M%S.png")
        ok, encoded = cv2.imencode(".png", box)
        if not ok:
            return None
        (folder / name).write_bytes(encoded.tobytes())
        _last_hud_diagnostic_at = now
        for old in sorted(folder.glob("hud-*.png"))[:-6]:
            old.unlink(missing_ok=True)
        return name
    except (OSError, ValueError, cv2.error):
        return None

