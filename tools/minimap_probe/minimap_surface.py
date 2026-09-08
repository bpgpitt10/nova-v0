#!/usr/bin/env python3
"""Read GSPro's minimap surface title (for example Tee or Fairway)."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
import json
from pathlib import Path
import re

import cv2
import numpy as np

import target_card


CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "gspro-round-watch.json"


@dataclass(frozen=True)
class MinimapSurfaceState:
    label: str | None
    normalized_label: str
    raw_ocr: str
    recognized: bool
    is_tee: bool
    confidence: float
    title_bbox: tuple[int, int, int, int]
    source: str = "gspro-minimap-surface-title"

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["title_bbox"] = list(self.title_bbox)
        return payload


def _config() -> dict:
    payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return payload["screen_detection"]["minimap_surface"]


def _crop_normalized(roi: np.ndarray, bounds: list[float] | tuple[float, ...]) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    if roi is None or roi.size == 0:
        raise ValueError("minimap ROI is empty")
    if len(bounds) != 4:
        raise ValueError("minimap surface title ROI must contain x1,y1,x2,y2")
    h, w = roi.shape[:2]
    x1f, y1f, x2f, y2f = [float(value) for value in bounds]
    x1 = max(0, min(w - 1, int(round(w * x1f))))
    y1 = max(0, min(h - 1, int(round(h * y1f))))
    x2 = max(x1 + 1, min(w, int(round(w * x2f))))
    y2 = max(y1 + 1, min(h, int(round(h * y2f))))
    return roi[y1:y2, x1:x2].copy(), (x1, y1, x2 - x1, y2 - y1)


def _normalize(raw: str | None) -> str:
    return "".join(re.findall(r"[a-z]+", str(raw or "").lower()))


def _recognize(raw: str, config: dict) -> tuple[str | None, bool, bool, float]:
    normalized = _normalize(raw)
    tee = _normalize(config["tee_label"])
    labels = [tee] + [_normalize(value) for value in config["recognized_non_tee_labels"]]
    labels = [value for value in labels if value]

    if normalized in labels:
        return normalized, True, normalized == tee, float(config["exact_match_confidence"])
    if not normalized or not labels:
        return None, False, False, 0.0

    best = max(labels, key=lambda candidate: SequenceMatcher(None, normalized, candidate).ratio())
    similarity = SequenceMatcher(None, normalized, best).ratio()
    if similarity >= float(config["fuzzy_match_min"]):
        return best, True, best == tee, float(config["fuzzy_match_confidence"])
    return normalized, False, False, 0.0


def read_minimap_surface(
    minimap_roi: np.ndarray,
    *,
    tesseract_path: str | None = None,
    detector_config: dict | None = None,
    debug_dir: str | Path | None = None,
) -> MinimapSurfaceState:
    config = detector_config or _config()
    crop, bbox = _crop_normalized(minimap_roi, config["title_roi_normalized"])
    tess = target_card._resolve_tesseract(tesseract_path)
    raw = target_card._ocr(
        crop,
        tess,
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
        psm=str(config["ocr_psm"]),
    )
    label, recognized, is_tee, confidence = _recognize(raw, config)

    if debug_dir is not None:
        out = Path(debug_dir)
        out.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out / "minimap_surface_title.png"), crop)
        (out / "minimap_surface.json").write_text(
            json.dumps({
                "raw_ocr": raw,
                "label": label,
                "recognized": recognized,
                "is_tee": is_tee,
                "confidence": confidence,
                "title_bbox": list(bbox),
            }, indent=2),
            encoding="utf-8",
        )

    return MinimapSurfaceState(
        label=label,
        normalized_label=_normalize(raw),
        raw_ocr=raw,
        recognized=recognized,
        is_tee=is_tee,
        confidence=confidence,
        title_bbox=bbox,
    )
