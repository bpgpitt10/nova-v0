#!/usr/bin/env python3
"""Read the always-visible GSPro wind panel from the top-center of the screen.

The live Looper path intentionally treats this as a non-fatal screen sensor. GSPro
has not exposed a dependable structured wind field in currentRound/Settings/logs,
while the top-center HUD consistently renders wind speed and a cardinal direction.

This module reports the display value only; it does not reinterpret whether GSPro's
cardinal label means wind-from or wind-toward. Downstream code can preserve the
GSPro display semantics until that convention is explicitly validated.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import cv2

import target_card


# Validated on the 3840x2160 Greywolf field capture. Normalized coordinates keep
# the reader resolution-independent while isolating the fixed top-center wind HUD.
DEFAULT_WIND_ROI = (0.432, 0.000, 0.568, 0.050)
VALID_DIRECTIONS = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"}


@dataclass
class WindState:
    speed_mph: int | None
    direction_cardinal: str | None
    speed_ocr_raw: str
    direction_ocr_raw: str
    panel_bbox: tuple[int, int, int, int]
    available: bool
    confidence: float
    source: str = "gspro-screen-wind-panel"
    direction_semantics: str = "gspro-display"


def _parse_override(text: str | None) -> tuple[int, int, int, int] | None:
    if not text:
        return None
    parts = [int(x.strip()) for x in text.split(",")]
    if len(parts) != 4:
        raise ValueError("--wind-roi must be x,y,w,h")
    return tuple(parts)  # type: ignore[return-value]


def _panel_bbox(screen, override: str | None = None) -> tuple[int, int, int, int]:
    H, W = screen.shape[:2]
    explicit = _parse_override(override)
    if explicit is not None:
        x, y, w, h = explicit
    else:
        x1, y1, x2, y2 = DEFAULT_WIND_ROI
        x = int(round(W * x1))
        y = int(round(H * y1))
        w = int(round(W * x2)) - x
        h = int(round(H * y2)) - y
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > W or y + h > H:
        raise RuntimeError(f"Invalid wind ROI {(x, y, w, h)} for screen {W}x{H}")
    return x, y, w, h


def _parse_speed(raw: str) -> int | None:
    compact = re.sub(r"\s+", "", raw).upper()
    m = re.search(r"(\d{1,2})(?:MPH)?", compact)
    if not m:
        return None
    value = int(m.group(1))
    return value if 0 <= value <= 99 else None


def _parse_direction(raw: str) -> str | None:
    letters = "".join(ch for ch in raw.upper() if ch in "NSEW")
    if letters in VALID_DIRECTIONS:
        return letters
    # PSM 10 can occasionally repeat a glyph. Collapse exact repeats only.
    if letters and len(set(letters)) == 1 and letters[:1] in VALID_DIRECTIONS:
        return letters[:1]
    return None


def _prep_hud(crop, scale: float = 3.0):
    """Preserve GSPro's thin white HUD glyphs; target-card OCR is too aggressive."""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 180, 255, cv2.THRESH_BINARY)
    return cv2.resize(binary, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def _ocr_hud(crop, tesseract: str, whitelist: str, psm: str) -> str:
    prepared = _prep_hud(crop)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        cv2.imwrite(tmp_path, prepared)
        kwargs = {"capture_output": True, "text": True, "timeout": 8}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        completed = subprocess.run(
            [
                tesseract,
                tmp_path,
                "stdout",
                "--psm",
                str(psm),
                "-c",
                f"tessedit_char_whitelist={whitelist}",
            ],
            **kwargs,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or f"Tesseract exited {completed.returncode}")
        return completed.stdout.strip().upper()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def read_wind_state(
    screen,
    tesseract_path: str | None = None,
    roi_override: str | None = None,
    debug_dir: Path | None = None,
) -> WindState:
    bbox = _panel_bbox(screen, roi_override)
    x, y, w, h = bbox
    panel = screen[y:y + h, x:x + w].copy()
    if panel.size == 0:
        raise RuntimeError("Wind panel crop was empty")

    tess = target_card._resolve_tesseract(tesseract_path)

    # The center arrow occupies the middle of the HUD. Keep OCR crops separated so
    # its icon cannot be hallucinated into the speed or direction strings.
    speed_crop = panel[:, : max(1, int(w * 0.42))]
    direction_crop = panel[:, min(w - 1, int(w * 0.68)) :]

    speed_raw = _ocr_hud(speed_crop, tess, "0123456789MPH", psm="7")
    direction_raw = _ocr_hud(direction_crop, tess, "NSEW", psm="10")
    speed = _parse_speed(speed_raw)
    direction = _parse_direction(direction_raw)

    # One fallback whole-panel pass is useful if GSPro shifts text a few pixels at
    # another resolution. It never overrides a successfully isolated field.
    if speed is None or direction is None:
        whole_raw = _ocr_hud(panel, tess, "0123456789MPHNSEW", psm="6")
        if speed is None:
            speed = _parse_speed(whole_raw)
            if speed is not None:
                speed_raw = whole_raw
        if direction is None:
            tail = re.sub(r"^.*MPH", "", whole_raw)
            direction = _parse_direction(tail)
            if direction is not None:
                direction_raw = tail

    available = speed is not None and direction is not None
    confidence = 1.0 if available else (0.5 if speed is not None or direction is not None else 0.0)

    if debug_dir is not None:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "wind_panel.png"), panel)
        cv2.imwrite(str(debug_dir / "wind_speed_crop.png"), _prep_hud(speed_crop))
        cv2.imwrite(str(debug_dir / "wind_direction_crop.png"), _prep_hud(direction_crop))

    return WindState(
        speed_mph=speed,
        direction_cardinal=direction,
        speed_ocr_raw=speed_raw,
        direction_ocr_raw=direction_raw,
        panel_bbox=bbox,
        available=available,
        confidence=confidence,
    )
