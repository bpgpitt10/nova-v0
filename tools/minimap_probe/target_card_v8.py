#!/usr/bin/env python3
"""v8 target-card OCR patch.

Field validation showed that the tightest legacy elevation crop can clip the top of
GSPro's small `5` glyph and make Tesseract read visible `5y` as `2y`.  v8 therefore
starts with a slightly taller crop that preserves the full glyph, then falls back to
broader crops for feet/inches cards such as `9'9`.

Importing this module patches target_card.read_target_card for the v8 orchestrator.
"""

from __future__ import annotations

import cv2

import probe_v6 as v6
import target_card


def read_target_card_v8(
    screen,
    tesseract_path: str | None = None,
    bbox_override: tuple[int, int, int, int] | None = None,
    debug_dir=None,
):
    bbox = bbox_override or target_card.detect_target_card(screen)
    x, y, w, h = bbox
    card = screen[y:y + h, x:x + w].copy()
    if card.size == 0:
        raise RuntimeError("Target card crop was empty.")

    tess = target_card._resolve_tesseract(tesseract_path)

    distance_crop = card[int(h * 0.08):int(h * 0.52), int(w * 0.12):int(w * 0.90)]
    distance_raw = target_card._ocr(distance_crop, tess, "0123456789", psm="7")
    distance = target_card._parse_distance(distance_raw)
    direction = target_card._green_triangle_direction(card)

    # IMPORTANT: do not start at y=.55.  On observed GSPro cards that crop clips
    # the top of a visible `5` and produces a repeatable false `2y` read.
    crop_specs = [
        (0.53, 0.91, 0.28, 0.90),
        (0.50, 0.94, 0.28, 0.94),
        (0.48, 0.86, 0.30, 0.90),
        (0.55, 0.89, 0.30, 0.88),  # legacy crop retained only as last fallback
    ]
    psms = ("7", "6", "8", "13")

    first_raw = ""
    chosen_crop = None
    elevation_raw = ""
    elevation_ft = None
    elevation_yds = None

    # Prefer the first semantically valid read from the field-proven crop order.
    # This avoids a 2-vs-2 vote tie where the clipped legacy crop previously won
    # simply because it appeared first.
    for y0, y1, x0, x1 in crop_specs:
        crop = card[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]
        if crop.size == 0:
            continue
        for psm in psms:
            raw = target_card._ocr(crop, tess, "0123456789yY'\"", psm=psm).strip()
            if raw and not first_raw:
                first_raw = raw
                chosen_crop = crop
            parsed_ft, parsed_yds = v6._strict_parse_elevation(raw, direction)
            if parsed_ft is not None and parsed_yds is not None:
                elevation_raw = raw
                elevation_ft = parsed_ft
                elevation_yds = parsed_yds
                chosen_crop = crop
                break
        if elevation_ft is not None:
            break

    if not elevation_raw:
        elevation_raw = first_raw
    if chosen_crop is None:
        chosen_crop = card[int(h * 0.53):int(h * 0.91), int(w * 0.28):int(w * 0.90)]

    if debug_dir is not None:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "latest_target_card.png"), card)
        cv2.imwrite(
            str(debug_dir / "latest_target_distance_ocr.png"),
            target_card._prep_ocr(distance_crop),
        )
        if chosen_crop is not None and chosen_crop.size:
            cv2.imwrite(
                str(debug_dir / "latest_target_elevation_ocr.png"),
                target_card._prep_ocr(chosen_crop),
            )

    return target_card.TargetCardState(
        distance_yds=distance,
        elevation_raw=elevation_raw,
        elevation_direction=direction,
        elevation_delta_ft=elevation_ft,
        elevation_delta_yds=elevation_yds,
        card_bbox=bbox,
        distance_ocr_raw=distance_raw,
        elevation_ocr_raw=elevation_raw,
    )


target_card.read_target_card = read_target_card_v8
