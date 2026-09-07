#!/usr/bin/env python3
"""Read GSPro course/hole identity from the persistent top-right round header.

Identity is intentionally separate from minimap geometry.  It answers which cached
HoleModel belongs to the current shot even when the minimap pin/green is cropped.
Tunable screen regions live in config/looper-live-caddie.json.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
import json
import re
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

import target_card


@dataclass
class HoleIdentity:
    course_name: str | None
    hole_number: int | None
    par: int | None
    hole_yards: int | None
    confidence: float
    raw_course_ocr: str
    raw_hole_ocr: str
    raw_meta_ocr: str
    source: str = "gspro-screen-round-header"

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["normalized_course"] = normalize_course_name(self.course_name)
        payload["identity_key"] = identity_key(self)
        return payload


def _default_config() -> dict:
    path = Path(__file__).resolve().parents[2] / "config" / "looper-live-caddie.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload["screen_detection"]["hole_identity"]


def normalize_course_name(value: str | None) -> str | None:
    if not value:
        return None
    text = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    return re.sub(r"\s+", " ", text) or None


def identity_key(identity: HoleIdentity | dict | None) -> str | None:
    if identity is None:
        return None
    if isinstance(identity, HoleIdentity):
        course = normalize_course_name(identity.course_name)
        hole = identity.hole_number
    else:
        course = normalize_course_name(identity.get("course_name") or identity.get("normalized_course"))
        hole = identity.get("hole_number")
    if course and hole is not None:
        return f"{course}::hole-{int(hole)}"
    return None


def _crop_normalized(screen: np.ndarray, bbox: list[float] | tuple[float, ...]) -> np.ndarray:
    h, w = screen.shape[:2]
    x1, y1, x2, y2 = [float(v) for v in bbox]
    xa, xb = max(0, int(round(x1 * w))), min(w, int(round(x2 * w)))
    ya, yb = max(0, int(round(y1 * h))), min(h, int(round(y2 * h)))
    if xb <= xa or yb <= ya:
        raise ValueError("invalid normalized GSPro header OCR region")
    return screen[ya:yb, xa:xb]


def _ocr(crop: np.ndarray, tesseract_path: str, *, psm: int, whitelist: str | None = None, scale: float = 2.0) -> str:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    if scale != 1.0:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    with tempfile.TemporaryDirectory(prefix="looper-hole-id-") as tmp:
        image_path = Path(tmp) / "region.png"
        cv2.imwrite(str(image_path), gray)
        cmd = [tesseract_path, str(image_path), "stdout", "--psm", str(int(psm))]
        if whitelist:
            cmd.extend(["-c", f"tessedit_char_whitelist={whitelist}"])
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5, check=False)
        text = (result.stdout or "").strip()
        if not text and result.returncode != 0:
            raise RuntimeError((result.stderr or "GSPro header OCR failed").strip())
        return text


def _clean_course(raw: str) -> str | None:
    # GSPro's rounded card edges can OCR as |, ], [, or punctuation.  Preserve
    # legitimate internal punctuation but trim border noise from the ends.
    text = re.sub(r"\s+", " ", raw.replace("\n", " ")).strip()
    text = re.sub(r"^[\s\|\[\]\(\)_:;.,'`]+", "", text)
    text = re.sub(r"[\s\|\[\]\(\)_:;.,'`]+$", "", text)
    text = re.sub(r"^\d{1,2}\s+", "", text).strip()
    return text or None


def parse_identity_text(*, course_raw: str, hole_raw: str, meta_raw: str) -> HoleIdentity:
    hole_match = re.search(r"\b(1[0-8]|[1-9])\b", hole_raw)
    hole = int(hole_match.group(1)) if hole_match else None

    meta = re.sub(r"\s+", " ", meta_raw.upper())
    par_match = re.search(r"\bPAR\s*([3-6])\b", meta)
    yards_match = re.search(r"\b(\d{3,4})\s*(?:YDS|YD|YARDS)\b", meta)
    par = int(par_match.group(1)) if par_match else None
    yards = int(yards_match.group(1)) if yards_match else None
    course = _clean_course(course_raw)

    confidence = 0.0
    confidence += 0.35 if hole is not None else 0.0
    confidence += 0.35 if course is not None else 0.0
    confidence += 0.15 if par is not None else 0.0
    confidence += 0.15 if yards is not None else 0.0

    return HoleIdentity(
        course_name=course,
        hole_number=hole,
        par=par,
        hole_yards=yards,
        confidence=round(confidence, 3),
        raw_course_ocr=course_raw,
        raw_hole_ocr=hole_raw,
        raw_meta_ocr=meta_raw,
    )


def read_hole_identity(
    screen: np.ndarray,
    *,
    tesseract_path: str | None = None,
    detector_config: dict | None = None,
    debug_dir: str | Path | None = None,
) -> HoleIdentity:
    config = detector_config or _default_config()
    executable = target_card._resolve_tesseract(tesseract_path)  # same local OCR dependency as PIN/AIM
    scale = float(config["ocr_scale"])

    hole_crop = _crop_normalized(screen, config["hole_number_roi"])
    course_crop = _crop_normalized(screen, config["course_name_roi"])
    meta_crop = _crop_normalized(screen, config["meta_roi"])

    hole_raw = _ocr(hole_crop, executable, psm=10, whitelist="0123456789", scale=scale)
    course_raw = _ocr(course_crop, executable, psm=7, scale=scale)
    meta_raw = _ocr(meta_crop, executable, psm=7, scale=scale)
    result = parse_identity_text(course_raw=course_raw, hole_raw=hole_raw, meta_raw=meta_raw)

    if debug_dir is not None:
        debug = Path(debug_dir)
        debug.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug / "hole_identity_number.png"), hole_crop)
        cv2.imwrite(str(debug / "hole_identity_course.png"), course_crop)
        cv2.imwrite(str(debug / "hole_identity_meta.png"), meta_crop)
        (debug / "hole_identity.json").write_text(json.dumps(result.to_dict(), indent=2), encoding="utf-8")

    return result
