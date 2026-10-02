#!/usr/bin/env python3
"""Read GSPro's white-bordered pre-shot target card from a screen capture.

The target card is the black card in the 3D view with:
- distance to target/pin on the top line;
- a green up/down triangle plus elevation on the bottom line.

This intentionally ignores red-bordered click/aim cards. Distance/elevation are
screen truth and remain available on tee shots where currentRound.dat can be stale.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class TargetCardState:
    distance_yds: float
    elevation_raw: str
    elevation_direction: str
    elevation_delta_ft: float | None
    elevation_delta_yds: float | None
    card_bbox: tuple[int, int, int, int]
    distance_ocr_raw: str
    elevation_ocr_raw: str
    source: str = "gspro-screen-target-card"


def _resolve_tesseract(explicit: str | None = None) -> str:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    env = os.environ.get("SIMREAD_TESSERACT_PATH")
    if env:
        candidates.append(Path(env))

    # Same locations SimRead checks, plus common sibling-repo locations on the sim PC.
    candidates.extend([
        Path.cwd() / "resources" / "tesseract" / "tesseract.exe",
        Path.cwd() / "vendor" / "tesseract" / "tesseract.exe",
        Path.cwd() / "bin" / "tesseract" / "tesseract.exe",
        Path.home() / "SimRead" / "resources" / "tesseract" / "tesseract.exe",
        Path.home() / "SimRead" / "vendor" / "tesseract" / "tesseract.exe",
        Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
    ])

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    on_path = shutil.which("tesseract")
    if on_path:
        return on_path

    raise RuntimeError(
        "Tesseract was not found. Install/use the same local Tesseract as SimRead, "
        "or set SIMREAD_TESSERACT_PATH to tesseract.exe."
    )


def _rect_ring_mask(shape: tuple[int, int], bbox: tuple[int, int, int, int], pad: int) -> np.ndarray:
    h, w = shape
    x, y, rw, rh = bbox
    outer = np.zeros((h, w), dtype=np.uint8)
    inner = np.zeros((h, w), dtype=np.uint8)
    cv2.rectangle(
        outer,
        (max(0, x - pad), max(0, y - pad)),
        (min(w - 1, x + rw + pad), min(h - 1, y + rh + pad)),
        255,
        -1,
    )
    cv2.rectangle(inner, (x, y), (x + rw, y + rh), 255, -1)
    return cv2.subtract(outer, inner)


def detect_target_card(screen: np.ndarray) -> tuple[int, int, int, int]:
    """Find the white-bordered black target card, rejecting red click-target cards."""
    H, W = screen.shape[:2]
    hsv = cv2.cvtColor(screen, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(screen, cv2.COLOR_BGR2GRAY)

    # Target cards live in the central 3D view. Excluding the top HUD and side
    # data panels removes most unrelated dark rectangles.
    search = np.zeros((H, W), dtype=np.uint8)
    cv2.rectangle(
        search,
        (int(W * 0.18), int(H * 0.14)),
        (int(W * 0.82), int(H * 0.68)),
        255,
        -1,
    )

    dark = ((gray < 72) & (search > 0)).astype(np.uint8) * 255
    dark = cv2.morphologyEx(
        dark,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)),
    )
    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates: list[tuple[float, tuple[int, int, int, int]]] = []
    for contour in contours:
        x, y, rw, rh = cv2.boundingRect(contour)
        if not (W * 0.032 <= rw <= W * 0.085):
            continue
        if not (H * 0.050 <= rh <= H * 0.125):
            continue

        area = cv2.contourArea(contour)
        rectangularity = area / max(float(rw * rh), 1.0)
        if rectangularity < 0.50:
            continue

        inner = gray[y:y + rh, x:x + rw]
        if inner.size == 0:
            continue
        dark_ratio = float((inner < 90).mean())
        if dark_ratio < 0.48:
            continue

        ring = _rect_ring_mask((H, W), (x, y, rw, rh), max(4, int(H * 0.007)))
        ring_pixels = hsv[ring > 0]
        if ring_pixels.size == 0:
            continue

        ring_sat = ring_pixels[:, 1].astype(float)
        ring_val = ring_pixels[:, 2].astype(float)
        white_ratio = float(((ring_sat < 55) & (ring_val > 185)).mean())

        # Red-bordered click cards have a saturated red ring. Reject them even if
        # white text inside produces a few white pixels near the edge.
        ring_hue = ring_pixels[:, 0].astype(float)
        red_ratio = float((((ring_hue <= 10) | (ring_hue >= 170)) & (ring_sat > 120) & (ring_val > 110)).mean())
        if red_ratio > 0.12:
            continue
        if white_ratio < 0.055:
            continue

        # Target cards contain large white numerals in their upper half.
        top = hsv[y:y + max(1, rh // 2), x:x + rw]
        text_ratio = float(((top[:, :, 1] < 70) & (top[:, :, 2] > 175)).mean())
        if text_ratio < 0.025:
            continue

        cx = x + rw / 2
        cy = y + rh / 2
        center_score = 1.0 - min(abs(cx - W / 2) / (W * 0.40), 1.0)
        vertical_score = 1.0 - min(abs(cy - H * 0.38) / (H * 0.28), 1.0)
        score = (
            rectangularity * 70
            + dark_ratio * 80
            + white_ratio * 180
            + text_ratio * 120
            + center_score * 18
            + vertical_score * 8
        )
        candidates.append((score, (x, y, rw, rh)))

    if not candidates:
        raise RuntimeError("Could not locate the white-bordered GSPro target card.")

    # Expand from the dark interior to include the white border, but not the long
    # pointer tail below the card.
    _, (x, y, rw, rh) = max(candidates, key=lambda item: item[0])
    pad = max(5, int(round(H * 0.006)))
    x1 = max(0, x - pad)
    y1 = max(0, y - pad)
    x2 = min(W, x + rw + pad)
    y2 = min(H, y + rh + pad)
    return x1, y1, x2 - x1, y2 - y1


def _prep_ocr(crop: np.ndarray, scale: int = 5) -> np.ndarray:
    if crop.size == 0:
        raise RuntimeError("Empty OCR crop")
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    enlarged = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    enlarged = cv2.GaussianBlur(enlarged, (3, 3), 0)
    _, binary = cv2.threshold(enlarged, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # GSPro is white text on black. Tesseract is more reliable with black text on white.
    if float(binary.mean()) < 127:
        binary = cv2.bitwise_not(binary)
    binary = cv2.copyMakeBorder(binary, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)
    return binary


def _ocr(image: np.ndarray, tesseract: str, whitelist: str, psm: str = "7") -> str:
    prepared = _prep_ocr(image)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        cv2.imwrite(tmp_path, prepared)
        completed = subprocess.run(
            [
                tesseract,
                tmp_path,
                "stdout",
                "--psm",
                psm,
                "-c",
                f"tessedit_char_whitelist={whitelist}",
            ],
            capture_output=True,
            text=True,
            windows_hidden=True if os.name == "nt" else False,
            timeout=8,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or f"Tesseract exited {completed.returncode}")
        return completed.stdout.strip()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _green_triangle_direction(card: np.ndarray) -> str:
    hsv = cv2.cvtColor(card, cv2.COLOR_BGR2HSV)
    H, W = card.shape[:2]
    lower = hsv[int(H * 0.48):int(H * 0.96), :int(W * 0.52)]
    mask = cv2.inRange(lower, np.array([35, 75, 90]), np.array([95, 255, 255]))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = [c for c in contours if 5 <= cv2.contourArea(c) <= max(500, card.size)]
    if not candidates:
        raise RuntimeError("Could not detect the green elevation triangle on the target card.")

    contour = max(candidates, key=cv2.contourArea)
    x, y, rw, rh = cv2.boundingRect(contour)
    M = cv2.moments(contour)
    if M["m00"] == 0 or rh < 3:
        raise RuntimeError("Elevation triangle geometry was invalid.")
    cy = M["m01"] / M["m00"]
    box_mid = y + rh / 2

    # Triangle centroid lies toward its base: centroid above box center means the
    # base is on top and the point faces down; below means the point faces up.
    return "down" if cy < box_mid else "up"


def _parse_distance(raw: str) -> float:
    digits = re.findall(r"\d+", raw)
    if not digits:
        raise RuntimeError(f"Could not parse target distance from OCR text {raw!r}")
    value = float(digits[0])
    if not (1 <= value <= 800):
        raise RuntimeError(f"Implausible target distance OCR value {value}")
    return value


def _parse_elevation(raw: str, direction: str) -> tuple[float | None, float | None]:
    text = raw.replace(" ”", '"').replace("“", '"').replace("”", '"').replace("’", "'")
    compact = re.sub(r"\s+", "", text)
    sign = -1.0 if direction == "down" else 1.0

    yard_match = re.search(r"(\d+(?:\.\d+)?)\s*[yY]", compact)
    if yard_match:
        feet = float(yard_match.group(1)) * 3.0 * sign
        return feet, feet / 3.0

    # Handles 5'3", 0'9", 5'3 and OCR with punctuation noise between digit groups.
    ft_in = re.search(r"(\d+)\s*['`]\s*(\d{1,2})", compact)
    if ft_in:
        feet = (float(ft_in.group(1)) + float(ft_in.group(2)) / 12.0) * sign
        return feet, feet / 3.0

    # If OCR preserved two numeric groups but lost the apostrophe, the target card's
    # feet/inches format is still unambiguous enough for a POC (e.g. '5 3').
    groups = re.findall(r"\d+", text)
    if len(groups) >= 2 and int(groups[1]) <= 11:
        feet = (float(groups[0]) + float(groups[1]) / 12.0) * sign
        return feet, feet / 3.0

    return None, None


def read_target_card(
    screen: np.ndarray,
    tesseract_path: str | None = None,
    bbox_override: tuple[int, int, int, int] | None = None,
    debug_dir: Path | None = None,
) -> TargetCardState:
    bbox = bbox_override or detect_target_card(screen)
    x, y, w, h = bbox
    card = screen[y:y + h, x:x + w].copy()
    if card.size == 0:
        raise RuntimeError("Target card crop was empty.")

    tess = _resolve_tesseract(tesseract_path)

    # The top value is large and centered. The lower line puts the triangle on the
    # left and elevation text to its right.
    distance_crop = card[int(h * 0.08):int(h * 0.52), int(w * 0.12):int(w * 0.90)]
    elevation_crop = card[int(h * 0.50):int(h * 0.94), int(w * 0.28):int(w * 0.94)]

    distance_raw = _ocr(distance_crop, tess, "0123456789")
    elevation_raw = _ocr(elevation_crop, tess, "0123456789yY'\"")
    direction = _green_triangle_direction(card)
    distance = _parse_distance(distance_raw)
    elevation_ft, elevation_yds = _parse_elevation(elevation_raw, direction)

    if debug_dir is not None:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "latest_target_card.png"), card)
        cv2.imwrite(str(debug_dir / "latest_target_distance_ocr.png"), _prep_ocr(distance_crop))
        cv2.imwrite(str(debug_dir / "latest_target_elevation_ocr.png"), _prep_ocr(elevation_crop))

        annotated = screen.copy()
        cv2.rectangle(annotated, (x, y), (x + w, y + h), (0, 255, 255), 2)
        label = f"target {distance:.0f} yd | {direction} | elev OCR: {elevation_raw or '?'}"
        cv2.putText(
            annotated,
            label,
            (x, max(20, y - 10)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (0, 255, 255),
            2,
            cv2.LINE_AA,
        )
        cv2.imwrite(str(debug_dir / "latest_screen_target_debug.png"), annotated)

    return TargetCardState(
        distance_yds=distance,
        elevation_raw=elevation_raw,
        elevation_direction=direction,
        elevation_delta_ft=elevation_ft,
        elevation_delta_yds=elevation_yds,
        card_bbox=bbox,
        distance_ocr_raw=distance_raw,
        elevation_ocr_raw=elevation_raw,
    )
