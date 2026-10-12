"""Read-only lie footer OCR from the same GSPro HWND image used for wind."""
from __future__ import annotations

import cv2
import numpy as np

import gspro_native_wind_ocr as wind
import gspro_window_capture as capture
from open_golf_coach_helper import utc_now_iso
from open_golf_coach_helper_lie_footer import _parse_candidate, RIGHT_FOOTER, LEFT_FOOTER


def _unavailable(note: str) -> dict:
    return {"status": "UNAVAILABLE", "surface": None, "upDownDegrees": None,
            "leftRightDegrees": None, "observedAt": utc_now_iso(),
            "confidence": None, "rawText": None, "ocrSource": "gspro-native-window",
            "note": note}


def extract_footer_crops(report: dict):
    """Coordinates are WINDOW-relative; never depend on desktop position/DPI."""
    if report.get("status") != "captured" or not report.get("quality", {}).get("nonblank", False):
        return []
    try:
        width, height = int(report["windowWidth"]), int(report["windowHeight"])
        raw = report.get("_private_bgra")
        if width < 640 or height < 360 or width * height > capture.MAX_CAPTURE_PIXELS:
            return []
        if not isinstance(raw, bytes) or len(raw) != width * height * 4:
            return []
        image = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)[:, :, :3]
        result = []
        for side, bounds in (("right", RIGHT_FOOTER), ("left", LEFT_FOOTER)):
            x1, y1, x2, y2 = bounds
            x, y = round(width*x1), round(height*y1)
            right, bottom = round(width*x2), round(height*y2)
            region = image[y:bottom, x:right]
            if region.size == 0:
                continue
            w = region.shape[1]
            long_end = max(2, round(w * .56))
            lat_start = round(w * .44)
            result.append((side, (x, y, region.shape[1], region.shape[0]),
                           (region[:, :long_end], region[:, lat_start:])))
        return result
    except (ValueError, TypeError, KeyError, cv2.error):
        return []


def _read_region(image):
    try:
        scaled = cv2.resize(image, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
        success, encoded = cv2.imencode(".png", scaled)
        if not success:
            return {"status": "error", "note": "lie_crop_encode_failed"}
        return wind._ocr_png_with_windows(encoded.tobytes())
    except (ValueError, cv2.error):
        return {"status": "error", "note": "lie_crop_invalid"}


def read_lie_from_capture(report: dict) -> dict:
    regions = extract_footer_crops(report)
    if not regions:
        return _unavailable("GSPro window capture unavailable or lie footer crop invalid.")
    candidates = []
    errors = []
    for side, (x, y, width, height), (long_image, lat_image) in regions:
        longitudinal = _read_region(long_image)
        lateral = _read_region(lat_image)
        if longitudinal.get("status") != "ok" or lateral.get("status") != "ok":
            errors.append(str(longitudinal.get("note") or lateral.get("note") or "windows_ocr_failed")[:120])
            continue
        candidate = _parse_candidate({
            "name": side, "footer": {"x": x, "y": y, "width": width, "height": height},
            "longitudinal": longitudinal, "lateral": lateral,
        })
        if candidate:
            candidates.append(candidate)
    if not candidates:
        return _unavailable("; ".join(errors)[:240] or "GSPro lie OCR returned no usable candidates.")
    best = max(candidates, key=lambda item: item["score"])
    missing = []
    if best["upDownDegrees"] is None:
        missing.append("up/down")
    if best["leftRightDegrees"] is None:
        missing.append("left/right")
    return {
        "status": "READY" if not missing else "UNKNOWN",
        "surface": None, "upDownDegrees": best["upDownDegrees"],
        "leftRightDegrees": best["leftRightDegrees"],
        "observedAt": utc_now_iso(), "confidence": None,
        "rawText": best["rawText"], "ocrSource": "gspro-native-window",
        "captureFreshness": "single_capture_unverified",
        "note": ("Lie footer read from GSPro native window. Signed +UP/-DOWN, +RIGHT/-LEFT."
                 if not missing else "Incomplete lie OCR: " + ", ".join(missing)),
    }


def read_gspro_native_lie(window: dict, *, captured: dict | None = None) -> dict:
    report = captured if captured is not None else capture.probe_gspro_capture(window, keep_pixels=True)
    return read_lie_from_capture(report)
