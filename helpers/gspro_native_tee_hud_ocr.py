"""Read-only GSPro first-tee HUD OCR from the SAME native window screenshot.

No shot-history dependency, no mouse input, no screenshot serialization.
The on-screen shot distance is separate from routed scorecard hole yardage.
Both labels must agree for this conservative initial release; nonmatching
doglegs remain blocked until independently validated.
"""
from __future__ import annotations

import math
import re

import cv2
import numpy as np

import gspro_native_wind_ocr as wind_ocr

# Ratios measured from real 3840x2160 FarmLinks GSPro fullscreen capture.
# Regions deliberately exclude player name and unrelated launch-monitor HUD.
REGIONS = {
    "shot": (0.000, 0.042, 0.150, 0.085),
    "course": (0.818, 0.009, 0.960, 0.047),
    "hole": (0.775, 0.008, 0.825, 0.086),
    "score": (0.840, 0.045, 0.962, 0.083),
}
OCR_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789. ,-|'&"
DISTANCE_MAX_SCORECARD_DELTA_YDS = 3.0


def _unavailable(reason: str, **details) -> dict:
    return {"status": "UNAVAILABLE", "reason": reason, **details}


def parse_tee_hud(shot_text: str, course_text: str, hole_text: str, score_text: str) -> dict:
    """Pure, conservative parser of four independent HUD crops."""
    # Anchored to Shot 1 and YDS; no accidental acceptance of wind, lie or elevation.
    shot = re.search(r"\bShot\s*([1-9]\d?)\b", shot_text, flags=re.I)
    yards = re.search(r"\b(\d{2,3}(?:[.,]\d)?)\s*YDS\b", shot_text, flags=re.I)
    course = re.sub(r"[^a-zA-Z0-9 &'\-]", " ", course_text)
    course = re.sub(r"\s+", " ", course).strip()
    hole_match = re.search(r"\b(\d{1,2})\b", hole_text)
    score_yards = re.search(r"\b(\d{2,3})\s*YDS\b", score_text, flags=re.I)

    if shot is None or int(shot.group(1)) != 1:
        return _unavailable("shot_one_not_verified")
    if yards is None:
        return _unavailable("shot_distance_not_read")
    distance = float(yards.group(1).replace(",", "."))
    if not math.isfinite(distance) or not 45 <= distance <= 750:
        return _unavailable("shot_distance_out_of_range")
    if hole_match is None or not 1 <= int(hole_match.group(1)) <= 18:
        return _unavailable("hole_number_not_read")
    if len(course) < 5 or len(re.sub(r"[^a-z0-9]", "", course.lower())) < 5:
        return _unavailable("course_name_not_read")
    if score_yards is None:
        return _unavailable("scorecard_yardage_not_read")

    score = int(score_yards.group(1))
    delta = abs(distance - score)
    if delta > DISTANCE_MAX_SCORECARD_DELTA_YDS:
        return _unavailable(
            "shot_scorecard_distance_disagree",
            # A dogleg can produce a legitimate routed/straight discrepancy.
            # Do not turn the scorecard into a false straight-line measurement.
            shotDistanceYds=distance,
            scorecardYards=score,
            differenceYds=round(delta, 2),
        )
    return {
        "status": "READY",
        "source": "gspro-native-shot-hud",
        "holeNumber": int(hole_match.group(1)),
        "shotNumber": 1,
        "courseText": course[:100],
        "straightDistanceYds": distance,
        "scorecardYards": score,
        "scorecardDifferenceYds": round(delta, 2),
        "confidence": "two_hud_distances_agree_course_hole_read",
        "spatialPrecision": "provisional_distance_only",
        "authorizesNativeAim": False,
    }


def _ocr_crop(bgr: np.ndarray, bounds: tuple[float, float, float, float], *, whitelist: str) -> str | None:
    height, width = bgr.shape[:2]
    x0, y0, x1, y1 = bounds
    left, top, right, bottom = (
        int(x0 * width), int(y0 * height),
        int(x1 * width), int(y1 * height),
    )
    if right <= left + 5 or bottom <= top + 5:
        return None
    image = cv2.resize(
        bgr[top:bottom, left:right], None, fx=2.5, fy=2.5,
        interpolation=cv2.INTER_CUBIC,
    )
    ok, data = cv2.imencode(".png", image)
    if not ok:
        return None
    result = wind_ocr._ocr_png_with_tesseract(
        data.tobytes(), psm=6, whitelist=whitelist,
    )
    return result.get("rawText", "") if result.get("status") == "ok" else None


def read_tee_hud_from_capture(report: dict) -> dict:
    """Never independently recapture; reuse the original minimap/wind/lie frame."""
    raw = report.get("_private_bgra")
    width, height = report.get("windowWidth"), report.get("windowHeight")
    if report.get("status") != "captured" or not isinstance(raw, bytes):
        return _unavailable("capture_unavailable")
    if (not isinstance(width, int) or not isinstance(height, int)
            or width < 1280 or height < 720 or len(raw) != width * height * 4):
        return _unavailable("capture_geometry_unverified")
    try:
        bgr = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)[:, :, :3]
        fields = {}
        for name, bounds in REGIONS.items():
            text = _ocr_crop(
                bgr, bounds,
                whitelist="0123456789 |" if name == "hole" else OCR_CHARS,
            )
            if text is None:
                return _unavailable("ocr_" + name + "_failed")
            fields[name] = text
        return parse_tee_hud(fields["shot"], fields["course"], fields["hole"], fields["score"])
    except (ValueError, OverflowError, cv2.error):
        return _unavailable("hud_crop_failed")
