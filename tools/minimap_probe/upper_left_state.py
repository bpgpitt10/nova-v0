#!/usr/bin/env python3
"""GSPro non-practice upper-left player/shot/DTP/elevation reader.

The non-practice HUD is a valuable independent state source. It exposes:
- current player name;
- shot number;
- current distance to pin with decimal precision;
- signed elevation to the pin in yards.

Default normalized ROIs are calibrated from two real 2048-wide GSPro screenshots.
Explicit x,y,w,h overrides remain available for diagnostics/resolution changes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import json
import re

import cv2
import numpy as np

import probe as base
import target_card


CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "gspro-upper-left-state.json"


@dataclass(frozen=True)
class UpperLeftShotState:
    player_name: str | None
    shot_number: int | None
    distance_to_pin_yds: float | None
    elevation_direction: str | None
    elevation_delta_yds: float | None
    player_ocr_raw: str
    shot_ocr_raw: str
    distance_ocr_raw: str
    elevation_ocr_raw: str
    player_bbox: tuple[int, int, int, int]
    shot_bbox: tuple[int, int, int, int]
    distance_bbox: tuple[int, int, int, int]
    elevation_bbox: tuple[int, int, int, int]
    source: str = "gspro-screen-upper-left-shot-state"

    def to_dict(self) -> dict:
        payload = asdict(self)
        for key in ("player_bbox", "shot_bbox", "distance_bbox", "elevation_bbox"):
            payload[key] = list(payload[key])
        return payload


def _config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def _crop_absolute(screen: np.ndarray, roi_text: str) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    x, y, w, h = base.parse_roi_arg(roi_text)
    sh, sw = screen.shape[:2]
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > sw or y + h > sh:
        raise ValueError(f"upper-left ROI {(x, y, w, h)} is outside screenshot {sw}x{sh}")
    return screen[y:y+h, x:x+w].copy(), (x, y, w, h)


def _crop_normalized(screen: np.ndarray, bounds: list[float] | tuple[float, ...]) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    if len(bounds) != 4:
        raise ValueError("normalized upper-left ROI must contain x1,y1,x2,y2")
    sh, sw = screen.shape[:2]
    x1f, y1f, x2f, y2f = [float(value) for value in bounds]
    if not (0 <= x1f < x2f <= 1 and 0 <= y1f < y2f <= 1):
        raise ValueError("normalized upper-left ROI must be within 0..1")
    x1 = max(0, min(sw - 1, int(round(sw * x1f))))
    y1 = max(0, min(sh - 1, int(round(sh * y1f))))
    x2 = max(x1 + 1, min(sw, int(round(sw * x2f))))
    y2 = max(y1 + 1, min(sh, int(round(sh * y2f))))
    return screen[y1:y2, x1:x2].copy(), (x1, y1, x2 - x1, y2 - y1)


def _crop(screen: np.ndarray, explicit: str | None, normalized: list[float]) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    return _crop_absolute(screen, explicit) if explicit else _crop_normalized(screen, normalized)


def _ocr(crop: np.ndarray, tesseract_path: str | None, whitelist: str, psm: str = "7") -> str:
    tess = target_card._resolve_tesseract(tesseract_path)
    return target_card._ocr(crop, tess, whitelist, psm=psm).strip()


def _first_int(raw: str) -> int | None:
    match = re.search(r"\d+", raw or "")
    return int(match.group(0)) if match else None


def _first_distance(raw: str) -> float | None:
    match = re.search(r"\d+(?:[.,]\d+)?", raw or "")
    if not match:
        return None
    return float(match.group(0).replace(",", "."))


def _player_name(raw: str) -> str | None:
    cleaned = " ".join(re.findall(r"[A-Za-z][A-Za-z'\-]*", raw or ""))
    return cleaned.strip() or None


def _green_triangle_direction(crop: np.ndarray, cfg: dict) -> str | None:
    """Return up/down from the green triangle geometry.

    A down-pointing triangle has its wide base at the top, so more green pixels lie
    in the top half than the bottom half. The inverse is true for an up triangle.
    """
    if crop is None or crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    lower = np.array(cfg["triangle_hsv_lower"], dtype=np.uint8)
    upper = np.array(cfg["triangle_hsv_upper"], dtype=np.uint8)
    mask = cv2.inRange(hsv, lower, upper)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = [c for c in contours if cv2.contourArea(c) >= float(cfg["triangle_min_area_px"])]
    if not candidates:
        return None
    contour = max(candidates, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(contour)
    if h < 3:
        return None
    local = mask[y:y+h, x:x+w] > 0
    split = max(1, h // 2)
    top = int(local[:split].sum())
    bottom = int(local[split:].sum())
    minimum_ratio = float(cfg["triangle_orientation_ratio_min"])
    if top > bottom * minimum_ratio:
        return "down"
    if bottom > top * minimum_ratio:
        return "up"
    moments = cv2.moments(contour)
    if moments["m00"] <= 0:
        return None
    cy = moments["m01"] / moments["m00"]
    return "down" if cy < y + h / 2 else "up"


def read_upper_left_state(
    screen: np.ndarray,
    *,
    shot_roi: str | None = None,
    distance_roi: str | None = None,
    elevation_roi: str | None = None,
    player_roi: str | None = None,
    tesseract_path: str | None = None,
    debug_dir: str | Path | None = None,
) -> UpperLeftShotState:
    cfg = _config()
    rois = cfg["roi_normalized"]
    player_crop, player_bbox = _crop(screen, player_roi, rois["player_name"])
    shot_crop, shot_bbox = _crop(screen, shot_roi, rois["shot_number"])
    distance_crop, distance_bbox = _crop(screen, distance_roi, rois["distance_to_pin"])
    elevation_crop, elevation_bbox = _crop(screen, elevation_roi, rois["elevation"])

    player_raw = _ocr(player_crop, tesseract_path, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'- ", psm=str(cfg["ocr_psm_name"]))
    shot_raw = _ocr(shot_crop, tesseract_path, "0123456789", psm=str(cfg["ocr_psm_numeric"]))
    distance_raw = _ocr(distance_crop, tesseract_path, "0123456789.,", psm=str(cfg["ocr_psm_numeric"]))
    elevation_raw = _ocr(elevation_crop, tesseract_path, "0123456789.,", psm=str(cfg["ocr_psm_numeric"]))

    shot_number = _first_int(shot_raw)
    distance = _first_distance(distance_raw)
    elevation_magnitude = _first_distance(elevation_raw)
    direction = _green_triangle_direction(elevation_crop, cfg)
    elevation_delta = None
    if elevation_magnitude is not None and direction is not None:
        elevation_delta = elevation_magnitude if direction == "up" else -elevation_magnitude

    result = UpperLeftShotState(
        player_name=_player_name(player_raw),
        shot_number=shot_number,
        distance_to_pin_yds=distance,
        elevation_direction=direction,
        elevation_delta_yds=elevation_delta,
        player_ocr_raw=player_raw,
        shot_ocr_raw=shot_raw,
        distance_ocr_raw=distance_raw,
        elevation_ocr_raw=elevation_raw,
        player_bbox=player_bbox,
        shot_bbox=shot_bbox,
        distance_bbox=distance_bbox,
        elevation_bbox=elevation_bbox,
    )

    if debug_dir is not None:
        out = Path(debug_dir)
        out.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out / "upper_left_player.png"), player_crop)
        cv2.imwrite(str(out / "upper_left_shot_number.png"), shot_crop)
        cv2.imwrite(str(out / "upper_left_distance_to_pin.png"), distance_crop)
        cv2.imwrite(str(out / "upper_left_elevation.png"), elevation_crop)
        (out / "upper_left_state.json").write_text(
            json.dumps(result.to_dict(), indent=2), encoding="utf-8"
        )
    return result
