#!/usr/bin/env python3
"""Read the persistent GSPro course/hole identity header."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
import unicodedata

import cv2
import numpy as np

import target_card


CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "gspro-round-watch.json"


@dataclass
class RoundIdentity:
    course_name: str | None
    hole_number: int | None
    par: int | None
    hole_yards: int | None
    confidence: float
    source: str
    raw_ocr: dict[str, str]
    field_valid: dict[str, bool]
    header_bbox: tuple[int, int, int, int]

    @property
    def cache_key(self) -> str | None:
        course = normalize_course_name(self.course_name)
        if not course or self.hole_number is None:
            return None
        return f"{course}::hole-{self.hole_number:02d}"

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["header_bbox"] = list(self.header_bbox)
        payload["cache_key"] = self.cache_key
        return payload


def _config() -> dict:
    payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return payload["screen_detection"]["round_identity"]


def normalize_course_name(value: str | None) -> str:
    if not value:
        return ""
    normalized = unicodedata.normalize("NFKD", str(value))
    normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    normalized = normalized.lower().replace("&", " and ")
    return " ".join(re.findall(r"[a-z0-9]+", normalized))


def _crop_normalized(screen: np.ndarray, roi: list[float] | tuple[float, ...]) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    if screen is None or screen.size == 0:
        raise ValueError("screen is empty")
    if len(roi) != 4:
        raise ValueError("normalized identity ROI must contain x1,y1,x2,y2")
    h, w = screen.shape[:2]
    x1f, y1f, x2f, y2f = [float(v) for v in roi]
    x1 = max(0, min(w - 1, int(round(w * x1f))))
    y1 = max(0, min(h - 1, int(round(h * y1f))))
    x2 = max(x1 + 1, min(w, int(round(w * x2f))))
    y2 = max(y1 + 1, min(h, int(round(h * y2f))))
    return screen[y1:y2, x1:x2].copy(), (x1, y1, x2 - x1, y2 - y1)


def _first_int(raw: str) -> int | None:
    match = re.search(r"\d+", raw or "")
    return int(match.group(0)) if match else None


def _clean_course(raw: str) -> str | None:
    text = (raw or "").strip()
    text = re.sub(r"^[|Il1]\s+(?=[A-Za-z])", "", text)
    text = re.sub(r"[^A-Za-z0-9 &'\-]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" -|'\t\r\n")
    return text or None


def _combined_bbox(boxes: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    x1 = min(box[0] for box in boxes)
    y1 = min(box[1] for box in boxes)
    x2 = max(box[0] + box[2] for box in boxes)
    y2 = max(box[1] + box[3] for box in boxes)
    return x1, y1, x2 - x1, y2 - y1


def read_round_identity(
    screen: np.ndarray,
    tesseract_path: str | None = None,
    detector_config: dict | None = None,
    debug_dir: str | Path | None = None,
) -> RoundIdentity:
    config = detector_config or _config()
    tess = target_card._resolve_tesseract(tesseract_path)

    hole_crop, hole_box = _crop_normalized(screen, config["hole_number_roi_normalized"])
    course_crop, course_box = _crop_normalized(screen, config["course_name_roi_normalized"])
    par_crop, par_box = _crop_normalized(screen, config["par_roi_normalized"])
    yards_crop, yards_box = _crop_normalized(screen, config["yards_roi_normalized"])

    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="round-id") as executor:
        hole_future = executor.submit(target_card._ocr, hole_crop, tess, "0123456789", "7")
        course_future = executor.submit(
            target_card._ocr, course_crop, tess,
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 &'-", "7"
        )
        par_future = executor.submit(target_card._ocr, par_crop, tess, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ", "7")
        yards_future = executor.submit(target_card._ocr, yards_crop, tess, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ", "7")
        hole_raw = hole_future.result()
        course_raw = course_future.result()
        par_raw = par_future.result()
        yards_raw = yards_future.result()

    hole = _first_int(hole_raw)
    par = _first_int(par_raw)
    yards = _first_int(yards_raw)
    course = _clean_course(course_raw)

    valid = {
        "course_name": bool(normalize_course_name(course)),
        "hole_number": hole is not None and int(config["hole_min"]) <= hole <= int(config["hole_max"]),
        "par": par is not None and int(config["par_min"]) <= par <= int(config["par_max"]),
        "hole_yards": yards is not None and int(config["yards_min"]) <= yards <= int(config["yards_max"]),
    }
    if not valid["hole_number"]:
        hole = None
    if not valid["par"]:
        par = None
    if not valid["hole_yards"]:
        yards = None
    if not valid["course_name"]:
        course = None

    confidence = (
        float(config["course_weight"]) * float(valid["course_name"])
        + float(config["hole_weight"]) * float(valid["hole_number"])
        + float(config["par_weight"]) * float(valid["par"])
        + float(config["yards_weight"]) * float(valid["hole_yards"])
    )
    confidence = max(0.0, min(1.0, confidence))
    header_box = _combined_bbox([hole_box, course_box, par_box, yards_box])
    result = RoundIdentity(
        course_name=course,
        hole_number=hole,
        par=par,
        hole_yards=yards,
        confidence=confidence,
        source="gspro-screen-course-hole-header",
        raw_ocr={
            "hole_number": hole_raw,
            "course_name": course_raw,
            "par": par_raw,
            "hole_yards": yards_raw,
        },
        field_valid=valid,
        header_bbox=header_box,
    )

    if debug_dir is not None:
        out = Path(debug_dir)
        out.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out / "round_identity_hole.png"), hole_crop)
        cv2.imwrite(str(out / "round_identity_course.png"), course_crop)
        cv2.imwrite(str(out / "round_identity_par.png"), par_crop)
        cv2.imwrite(str(out / "round_identity_yards.png"), yards_crop)

    return result


def try_read_round_identity(
    screen: np.ndarray,
    tesseract_path: str | None = None,
    detector_config: dict | None = None,
    debug_dir: str | Path | None = None,
) -> tuple[RoundIdentity | None, str | None]:
    try:
        identity = read_round_identity(
            screen,
            tesseract_path=tesseract_path,
            detector_config=detector_config,
            debug_dir=debug_dir,
        )
        minimum = float((detector_config or _config())["minimum_usable_confidence"])
        if identity.cache_key is None:
            return identity, "course/hole cache key is incomplete"
        if identity.confidence < minimum:
            return identity, f"round identity OCR confidence {identity.confidence:.2f} is below preferred {minimum:.2f}"
        return identity, None
    except Exception as exc:
        return None, str(exc)
