#!/usr/bin/env python3
"""Shared GSPro target-card reader with adaptive distance consensus.

The DPC Pebble field run preserved an 83-yard white PIN card that a legacy single
OCR crop read as 2. This reader uses two fast independent crops first and expands to
additional crops/PSMs only on disagreement. The watcher can call the distance-only
function so tee/post-shot readiness does not pay for elevation OCR every poll.

Structured DistanceToPin validation belongs to the watcher/ShotState resolver because
this module intentionally does not guess which completed GSPro shot is current.
"""
from __future__ import annotations

from collections import Counter
import re
from typing import Any

import cv2

import probe_v6 as v6  # installs the field-validated PIN-card detector
import target_card


_FAST_DISTANCE_SPECS = [
    ("primary-7", (0.06, 0.55, 0.08, 0.94), "7"),
    ("broad-7", (0.02, 0.60, 0.02, 0.98), "7"),
]
_FALLBACK_DISTANCE_SPECS = [
    ("primary-6", (0.06, 0.56, 0.08, 0.94), "6"),
    ("legacy-7", (0.08, 0.52, 0.12, 0.90), "7"),
    ("broad-8", (0.02, 0.62, 0.02, 0.98), "8"),
    ("broad-13", (0.02, 0.62, 0.02, 0.98), "13"),
]


def _card_crop(screen, bbox_override=None):
    bbox = bbox_override or target_card.detect_target_card(screen)
    x, y, w, h = bbox
    card = screen[y:y + h, x:x + w].copy()
    if card.size == 0:
        raise RuntimeError("Target card crop was empty.")
    return bbox, card


def _distance_attempt(card, tess: str, spec) -> dict[str, Any] | None:
    label, (y0, y1, x0, x1), psm = spec
    h, w = card.shape[:2]
    crop = card[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]
    if crop.size == 0:
        return None
    raw = target_card._ocr(crop, tess, "0123456789", psm=psm).strip()
    groups = re.findall(r"\d+", raw)
    if not groups:
        return {"label": label, "psm": psm, "raw": raw, "value": None, "crop": crop}
    try:
        value = int(groups[0])
    except Exception:
        value = None
    if value is not None and not (1 <= value <= 800):
        value = None
    return {"label": label, "psm": psm, "raw": raw, "value": value, "crop": crop}


def _choose_distance(attempts: list[dict[str, Any]]) -> float:
    valid = [item for item in attempts if item.get("value") is not None]
    if not valid:
        raise RuntimeError("Could not parse target distance from any consensus OCR crop.")
    values = [int(item["value"]) for item in valid]
    counts = Counter(values)
    max_count = max(counts.values())
    tied = [value for value, count in counts.items() if count == max_count]
    if len(tied) == 1:
        return float(tied[0])

    # Tie-break by earliest/highest-priority valid observation. This avoids inventing
    # a numeric preference such as "larger is more likely"; caller-level structured
    # or tee-header cross-checks remain the semantic guard.
    for item in valid:
        if int(item["value"]) in tied:
            return float(item["value"])
    raise AssertionError("unreachable distance tie")


def read_target_distance_v9(
    screen,
    tesseract_path: str | None = None,
    bbox_override: tuple[int, int, int, int] | None = None,
    debug_dir=None,
):
    """Return distance-only consensus quickly for watcher readiness loops.

    Returns `(distance_yds, bbox, attempts)`. Attempts are JSON-friendly after the
    private image crop is removed by `_attempts_for_json`.
    """
    bbox, card = _card_crop(screen, bbox_override)
    tess = target_card._resolve_tesseract(tesseract_path)
    attempts: list[dict[str, Any]] = []

    for spec in _FAST_DISTANCE_SPECS:
        item = _distance_attempt(card, tess, spec)
        if item is not None:
            attempts.append(item)

    fast_values = [int(item["value"]) for item in attempts if item.get("value") is not None]
    if len(fast_values) >= 2 and fast_values[0] == fast_values[1]:
        chosen = float(fast_values[0])
    else:
        for spec in _FALLBACK_DISTANCE_SPECS:
            item = _distance_attempt(card, tess, spec)
            if item is not None:
                attempts.append(item)
        chosen = _choose_distance(attempts)

    if debug_dir is not None:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "latest_target_card.png"), card)
        try:
            (debug_dir / "latest_target_distance_candidates.txt").write_text(
                "\n".join(
                    f"{item['label']} psm={item['psm']} raw={item['raw']!r} value={item.get('value')!r}"
                    for item in attempts
                ),
                encoding="utf-8",
            )
        except Exception:
            pass
        primary = next((item.get("crop") for item in attempts if item.get("crop") is not None), None)
        if primary is not None and primary.size:
            cv2.imwrite(
                str(debug_dir / "latest_target_distance_ocr.png"),
                target_card._prep_ocr(primary),
            )
    return chosen, bbox, attempts


def _attempts_for_json(attempts):
    return [
        {"label": item.get("label"), "psm": item.get("psm"), "raw": item.get("raw"), "value": item.get("value")}
        for item in attempts
    ]


def _read_elevation(card, tess: str, direction: str, debug_dir=None):
    h, w = card.shape[:2]
    specs = [
        ("yards-primary", (0.53, 0.91, 0.28, 0.90), "7"),
        ("feet-primary", (0.48, 0.86, 0.30, 0.90), "7"),
        ("yards-alt", (0.53, 0.91, 0.28, 0.90), "6"),
        ("feet-alt", (0.48, 0.86, 0.30, 0.90), "6"),
        ("broad", (0.50, 0.94, 0.28, 0.94), "7"),
        ("broad", (0.50, 0.94, 0.28, 0.94), "6"),
        ("yards-primary", (0.53, 0.91, 0.28, 0.90), "8"),
        ("feet-primary", (0.48, 0.86, 0.30, 0.90), "8"),
    ]
    first_raw = ""
    first_crop = None
    attempts = []
    winner = None
    for label, (y0, y1, x0, x1), psm in specs:
        crop = card[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]
        if crop.size == 0:
            continue
        raw = target_card._ocr(crop, tess, "0123456789yY'\"", psm=psm).strip()
        if raw and not first_raw:
            first_raw, first_crop = raw, crop
        parsed_ft, parsed_yds = v6._strict_parse_elevation(raw, direction)
        attempts.append((label, psm, raw, parsed_ft))
        if parsed_ft is not None and parsed_yds is not None:
            winner = (raw, parsed_ft, parsed_yds, crop)
            break

    if winner is not None:
        raw, feet, yards, chosen_crop = winner
    else:
        raw, feet, yards, chosen_crop = first_raw, None, None, first_crop

    if debug_dir is not None:
        try:
            (debug_dir / "latest_target_elevation_attempts.txt").write_text(
                "\n".join(
                    f"{label} psm={psm} raw={ocr!r} parsed_ft={parsed!r}"
                    for label, psm, ocr, parsed in attempts
                ),
                encoding="utf-8",
            )
        except Exception:
            pass
        if chosen_crop is not None and chosen_crop.size:
            cv2.imwrite(
                str(debug_dir / "latest_target_elevation_ocr.png"),
                target_card._prep_ocr(chosen_crop),
            )
    return raw, feet, yards


def read_target_card_v9(
    screen,
    tesseract_path: str | None = None,
    bbox_override: tuple[int, int, int, int] | None = None,
    debug_dir=None,
):
    distance, bbox, attempts = read_target_distance_v9(
        screen,
        tesseract_path=tesseract_path,
        bbox_override=bbox_override,
        debug_dir=debug_dir,
    )
    x, y, w, h = bbox
    card = screen[y:y + h, x:x + w].copy()
    tess = target_card._resolve_tesseract(tesseract_path)
    direction = target_card._green_triangle_direction(card)
    elevation_raw, elevation_ft, elevation_yds = _read_elevation(
        card, tess, direction, debug_dir=debug_dir
    )
    candidate_text = " | ".join(
        f"{item['label']}:{item['raw']}->{item.get('value')}"
        for item in _attempts_for_json(attempts)
    )
    return target_card.TargetCardState(
        distance_yds=distance,
        elevation_raw=elevation_raw,
        elevation_direction=direction,
        elevation_delta_ft=elevation_ft,
        elevation_delta_yds=elevation_yds,
        card_bbox=bbox,
        distance_ocr_raw=candidate_text,
        elevation_ocr_raw=elevation_raw,
        source="gspro-screen-target-card-v9-consensus",
    )


# Make tee and post-tee child probes use the same full-card reader once imported.
target_card.read_target_card = read_target_card_v9
