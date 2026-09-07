#!/usr/bin/env python3
"""GSPro non-practice upper-left shot number + distance-to-pin reader.

We intentionally do NOT guess screen coordinates before the user can provide a real
non-practice screenshot.  The reader therefore requires two explicit x,y,w,h ROIs:
one containing the shot number and one containing current distance-to-pin.

Once those ROIs are calibrated, this adapter can populate the already-existing
RoundObservation fields without changing tee-state, shot-progression, or source-
resolution calculations.
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


@dataclass(frozen=True)
class UpperLeftShotState:
    shot_number: int | None
    distance_to_pin_yds: float | None
    shot_ocr_raw: str
    distance_ocr_raw: str
    shot_bbox: tuple[int, int, int, int]
    distance_bbox: tuple[int, int, int, int]
    source: str = "gspro-screen-upper-left-shot-state"

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["shot_bbox"] = list(self.shot_bbox)
        payload["distance_bbox"] = list(self.distance_bbox)
        return payload


def _crop(screen: np.ndarray, roi_text: str) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    if not roi_text:
        raise ValueError("upper-left OCR requires an explicit x,y,w,h ROI")
    x, y, w, h = base.parse_roi_arg(roi_text)
    sh, sw = screen.shape[:2]
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > sw or y + h > sh:
        raise ValueError(f"upper-left ROI {(x, y, w, h)} is outside screenshot {sw}x{sh}")
    return screen[y:y+h, x:x+w].copy(), (x, y, w, h)


def _numeric_ocr(crop: np.ndarray, tesseract_path: str | None) -> str:
    tess = target_card._resolve_tesseract(tesseract_path)
    return target_card._ocr(crop, tess, "0123456789.,", psm="7").strip()


def _first_int(raw: str) -> int | None:
    match = re.search(r"\d+", raw or "")
    return int(match.group(0)) if match else None


def _first_distance(raw: str) -> float | None:
    match = re.search(r"\d+(?:[.,]\d+)?", raw or "")
    if not match:
        return None
    return float(match.group(0).replace(",", "."))


def read_upper_left_state(
    screen: np.ndarray,
    *,
    shot_roi: str,
    distance_roi: str,
    tesseract_path: str | None = None,
    debug_dir: str | Path | None = None,
) -> UpperLeftShotState:
    shot_crop, shot_bbox = _crop(screen, shot_roi)
    distance_crop, distance_bbox = _crop(screen, distance_roi)
    shot_raw = _numeric_ocr(shot_crop, tesseract_path)
    distance_raw = _numeric_ocr(distance_crop, tesseract_path)

    result = UpperLeftShotState(
        shot_number=_first_int(shot_raw),
        distance_to_pin_yds=_first_distance(distance_raw),
        shot_ocr_raw=shot_raw,
        distance_ocr_raw=distance_raw,
        shot_bbox=shot_bbox,
        distance_bbox=distance_bbox,
    )

    if debug_dir is not None:
        out = Path(debug_dir)
        out.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out / "upper_left_shot_number.png"), shot_crop)
        cv2.imwrite(str(out / "upper_left_distance_to_pin.png"), distance_crop)
        (out / "upper_left_state.json").write_text(
            json.dumps(result.to_dict(), indent=2), encoding="utf-8"
        )
    return result
