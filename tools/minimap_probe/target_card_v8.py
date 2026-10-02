#!/usr/bin/env python3
"""v8 target-card OCR patch.

Field validation showed that an overly tight elevation crop can clip GSPro's small
`5` glyph and turn visible `5y` into OCR `2y`. v8 uses field-proven crop priority
and an adaptive fast path so common cards need only one or two elevation OCR calls.

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

    # Fast priority is intentional:
    # 1) full-glyph yards crop solves the observed 5y card in one pass;
    # 2) punctuation-preserving feet crop solves observed 9'9 in one pass;
    # 3) alternate PSM/crops are only fallbacks.
    attempts = [
        ("yards-primary", (0.53, 0.91, 0.28, 0.90), "7"),
        ("feet-primary", (0.48, 0.86, 0.30, 0.90), "7"),
        ("yards-alt", (0.53, 0.91, 0.28, 0.90), "6"),
        ("feet-alt", (0.48, 0.86, 0.30, 0.90), "6"),
        ("broad", (0.50, 0.94, 0.28, 0.94), "7"),
        ("broad", (0.50, 0.94, 0.28, 0.94), "6"),
        ("yards-primary", (0.53, 0.91, 0.28, 0.90), "8"),
        ("feet-primary", (0.48, 0.86, 0.30, 0.90), "8"),
        ("legacy-last", (0.55, 0.89, 0.30, 0.88), "7"),
    ]

    first_raw = ""
    chosen_crop = None
    elevation_raw = ""
    elevation_ft = None
    elevation_yds = None
    debug_attempts: list[str] = []

    for label, (y0, y1, x0, x1), psm in attempts:
        crop = card[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]
        if crop.size == 0:
            continue
        raw = target_card._ocr(crop, tess, "0123456789yY'\"", psm=psm).strip()
        if raw and not first_raw:
            first_raw = raw
            chosen_crop = crop
        parsed_ft, parsed_yds = v6._strict_parse_elevation(raw, direction)
        debug_attempts.append(
            f"{label} psm={psm} raw={raw!r} parsed_ft={parsed_ft!r}"
        )
        if parsed_ft is not None and parsed_yds is not None:
            elevation_raw = raw
            elevation_ft = parsed_ft
            elevation_yds = parsed_yds
            chosen_crop = crop
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
        try:
            (debug_dir / "latest_target_elevation_attempts.txt").write_text(
                "\n".join(debug_attempts), encoding="utf-8"
            )
        except Exception:
            pass

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
