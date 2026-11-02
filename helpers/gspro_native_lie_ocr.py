"""Read-only lie footer OCR from the same GSPro HWND image used for wind."""
from __future__ import annotations

import re

import cv2
import numpy as np

import gspro_native_wind_ocr as wind
import gspro_window_capture as capture
from open_golf_coach_helper import utc_now_iso
from open_golf_coach_helper_lie_footer import _component, _parse_candidate, RIGHT_FOOTER, LEFT_FOOTER


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


# Tesseract first: one footer half takes ~0.1-0.2 s, against ~1 s per half
# for the Windows OCR, which starts PowerShell each time (3.8 s per lie read
# on Brian's sim, 2 Nov 2026). Each half is read at a few heights and a value
# counts when two reads agree; otherwise that side falls back to Windows OCR.
LIE_TARGET_HEIGHTS = (40, 60, 80)
LIE_PAD_PX = 16
LIE_BINARY_THRESHOLD = 170
LIE_WHITELIST = "0123456789.UPDOWNRIGHTLEF "
_TOLERANT = (
    (re.compile(r"D\s*O\s*W\s*N|D\s*O\s*W|D\s*O\s*N|O\s*W\s*N"), "DOWN"),
    (re.compile(r"R\s*I\s*G\s*H\s*T|R\s*I\s*G\s*H|I\s*G\s*H\s*T|R\s*I\s*G"), "RIGHT"),
    (re.compile(r"L\s*E\s*F\s*T|L\s*E\s*F|E\s*F\s*T"), "LEFT"),
)


def _canonical_lie_text(text: str) -> str:
    out = (text or "").upper()
    for pattern, word in _TOLERANT:
        out = pattern.sub(word, out)
    return out


def _tesseract_half(image, target_height: int) -> dict:
    try:
        scale = target_height / max(1, image.shape[0])
        enlarged = cv2.resize(image, None, fx=scale, fy=scale,
                              interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
        b, g, red = cv2.split(enlarged)
        luminance = 0.0722 * b.astype(np.float32) + 0.7152 * g.astype(np.float32) + 0.2126 * red.astype(np.float32)
        binary = np.where(luminance >= LIE_BINARY_THRESHOLD, 0, 255).astype(np.uint8)
        binary = cv2.copyMakeBorder(binary, LIE_PAD_PX, LIE_PAD_PX, LIE_PAD_PX, LIE_PAD_PX,
                                    cv2.BORDER_CONSTANT, value=255)
        ok, encoded = cv2.imencode(".png", binary)
        if not ok:
            return {"status": "error", "note": "lie_crop_encode_failed"}
        return wind._ocr_png_with_tesseract(encoded.tobytes(), psm=7, whitelist=LIE_WHITELIST)
    except (ValueError, cv2.error):
        return {"status": "error", "note": "lie_crop_invalid"}


def _agreed_component(image, positive: str, negative: str):
    """(signed value, direction, text) once two reads agree, else None."""
    seen: dict[tuple, int] = {}
    for height in LIE_TARGET_HEIGHTS:
        result = _tesseract_half(image, height)
        if result.get("status") != "ok":
            return None
        text = _canonical_lie_text(result.get("rawText") or "")
        value, direction = _component(text, positive, negative)
        if value is None:
            continue
        key = (value, direction)
        seen[key] = seen.get(key, 0) + 1
        if seen[key] >= 2:
            return value, direction, text
    return None


def _tesseract_candidate(side, footer, long_image, lat_image):
    if wind._tesseract_bundle() is None:
        return None
    longitudinal = _agreed_component(long_image, "UP", "DOWN")
    lateral = _agreed_component(lat_image, "RIGHT", "LEFT")
    if longitudinal is None or lateral is None:
        return None
    up_down, up_down_dir, long_text = longitudinal
    left_right, left_right_dir, lat_text = lateral
    x, y, width, height = footer
    return {
        "score": 2,
        "upDownDegrees": up_down,
        "leftRightDegrees": left_right,
        "rawText": f"{abs(up_down):.1f} {up_down_dir} {abs(left_right):.1f} {left_right_dir}",
        "ocrRawText": {"longitudinal": long_text, "lateral": lat_text},
        "capture": {"side": side, "footer": {"x": x, "y": y, "width": width, "height": height}},
        "engine": "tesseract-cli",
    }


def read_lie_from_capture(report: dict) -> dict:
    regions = extract_footer_crops(report)
    if not regions:
        return _unavailable("GSPro window capture unavailable or lie footer crop invalid.")
    candidates = []
    errors = []
    for side, (x, y, width, height), (long_image, lat_image) in regions:
        fast = _tesseract_candidate(side, (x, y, width, height), long_image, lat_image)
        if fast:
            candidates.append(fast)
            break  # both values agreed on this side: no need to read the other
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
            if candidate["score"] == 2:
                break
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
        "ocrEngine": best.get("engine", "windows-winrt"),
        "captureFreshness": "single_capture_unverified",
        "note": ("Lie footer read from GSPro native window. Signed +UP/-DOWN, +RIGHT/-LEFT."
                 if not missing else "Incomplete lie OCR: " + ", ".join(missing)),
    }


def read_gspro_native_lie(window: dict, *, captured: dict | None = None) -> dict:
    report = captured if captured is not None else capture.probe_gspro_capture(window, keep_pixels=True)
    return read_lie_from_capture(report)
