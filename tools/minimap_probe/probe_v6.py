#!/usr/bin/env python3
"""GSPro live-state + minimap hazard probe v6.

v6 understands both GSPro card roles:
- white PIN card: permanent distance/elevation anchor;
- player-color AIM card: current selected/default aim-point distance/elevation.

The AIM card follows the player's/team color, so it must not be hard-coded red.
Elevation OCR uses an adaptive fast path: two agreeing reads from a field-validated
crop are enough. Only ambiguous cards fall back to the broader multi-crop vote.
This preserves the 5y-vs-2y fix while avoiding ~16 Tesseract launches per card on
the common path.
"""

from __future__ import annotations

import argparse
import re
from collections import Counter

import cv2

import probe_v5 as v5
import target_card
import target_cards_v6


# v5's read_target_card() calls this global when no debug ROI is supplied. Patch it
# to the v6 white PIN-card detector.
target_card.detect_target_card = target_cards_v6.detect_pin_bbox


def _strict_parse_elevation(raw: str, direction: str) -> tuple[float | None, float | None]:
    """Parse GSPro elevation, refusing impossible feet/inches OCR results."""
    text = (
        raw.replace(" ”", '"')
        .replace("“", '"')
        .replace("”", '"')
        .replace("’", "'")
    )
    compact = re.sub(r"\s+", "", text)
    sign = -1.0 if direction == "down" else 1.0

    yard_match = re.search(r"(\d+(?:\.\d+)?)\s*[yY]", compact)
    if yard_match:
        feet = float(yard_match.group(1)) * 3.0 * sign
        return feet, feet / 3.0

    ft_in = re.search(r"(\d+)\s*['`]\s*(\d{1,2})", compact)
    if ft_in:
        inches = int(ft_in.group(2))
        if 0 <= inches <= 11:
            feet = (float(ft_in.group(1)) + inches / 12.0) * sign
            return feet, feet / 3.0
        return None, None

    # OCR sometimes drops punctuation but leaves two numeric groups separated by
    # whitespace/noise. A single run-together token such as `99` is deliberately
    # NOT interpreted as 9'9 because that would be too easy to hallucinate.
    groups = re.findall(r"\d+", text)
    if len(groups) >= 2:
        inches = int(groups[1])
        if 0 <= inches <= 11:
            feet = (float(groups[0]) + inches / 12.0) * sign
            return feet, feet / 3.0

    return None, None


def _candidate_key(feet: float) -> int:
    """Normalize semantically equivalent OCR reads to signed total inches."""
    return int(round(feet * 12.0))


def _read_target_card_v6(
    screen,
    tesseract_path: str | None = None,
    bbox_override: tuple[int, int, int, int] | None = None,
    debug_dir=None,
):
    """Read one already-located target card with adaptive consensus OCR."""
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

    # Field-validated fast paths. The first crop keeps the full single-digit yard
    # glyph (important: a tighter crop turned visible `5y` into OCR `2y`). The
    # second crop preserves feet/inches punctuation such as 9'9.
    fast_specs = [
        ("yards", (0.53, 0.91, 0.28, 0.90), ("7", "6")),
        ("feet", (0.48, 0.86, 0.30, 0.90), ("7", "6")),
    ]

    first_raw = ""
    first_crop = None
    all_candidates: list[tuple[str, float, float, object, str, str]] = []
    winner = None

    for label, (y0, y1, x0, x1), psms in fast_specs:
        crop = card[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]
        if crop.size == 0:
            continue
        local_candidates = []
        for psm in psms:
            raw = target_card._ocr(crop, tess, "0123456789yY'\"", psm=psm).strip()
            if raw and not first_raw:
                first_raw = raw
                first_crop = crop
            parsed_ft, parsed_yds = _strict_parse_elevation(raw, direction)
            if parsed_ft is not None and parsed_yds is not None:
                item = (raw, parsed_ft, parsed_yds, crop, psm, label)
                local_candidates.append(item)
                all_candidates.append(item)

        # Two independent PSMs agreeing on the same semantic value is enough for
        # the common path. This cuts a typical PIN read from 16 elevation OCR calls
        # to 2, and a feet/inches AIM read to 4 or fewer.
        if len(local_candidates) >= 2:
            keys = [_candidate_key(item[1]) for item in local_candidates]
            if len(set(keys)) == 1:
                winner = local_candidates[0]
                break

    if winner is None:
        # Ambiguous cards fall back to the older broad vote. Order the known-good
        # full-glyph crop first so ties favor it rather than the clipped crop.
        fallback_specs = [
            (0.53, 0.91, 0.28, 0.90),
            (0.48, 0.86, 0.30, 0.90),
            (0.50, 0.94, 0.28, 0.94),
            (0.55, 0.89, 0.30, 0.88),
        ]
        psms = ("7", "8", "13", "6")
        seen = {(item[5], item[4], item[0]) for item in all_candidates}

        for y0, y1, x0, x1 in fallback_specs:
            crop = card[int(h * y0):int(h * y1), int(w * x0):int(w * x1)]
            if crop.size == 0:
                continue
            for psm in psms:
                raw = target_card._ocr(crop, tess, "0123456789yY'\"", psm=psm).strip()
                if raw and not first_raw:
                    first_raw = raw
                    first_crop = crop
                parsed_ft, parsed_yds = _strict_parse_elevation(raw, direction)
                if parsed_ft is not None and parsed_yds is not None:
                    all_candidates.append((raw, parsed_ft, parsed_yds, crop, psm, "fallback"))

        if all_candidates:
            keys = [_candidate_key(item[1]) for item in all_candidates]
            counts = Counter(keys)
            winning_key, _votes = counts.most_common(1)[0]
            winner = next(item for item, key in zip(all_candidates, keys) if key == winning_key)

    elevation_raw = first_raw
    elevation_ft = None
    elevation_yds = None
    chosen_elevation_crop = first_crop
    if winner is not None:
        elevation_raw, elevation_ft, elevation_yds, chosen_elevation_crop, _psm, _label = winner

    if chosen_elevation_crop is None:
        chosen_elevation_crop = card[int(h * 0.53):int(h * 0.91), int(w * 0.28):int(w * 0.90)]

    if debug_dir is not None:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "latest_target_card.png"), card)
        cv2.imwrite(
            str(debug_dir / "latest_target_distance_ocr.png"),
            target_card._prep_ocr(distance_crop),
        )
        if chosen_elevation_crop is not None and chosen_elevation_crop.size:
            cv2.imwrite(
                str(debug_dir / "latest_target_elevation_ocr.png"),
                target_card._prep_ocr(chosen_elevation_crop),
            )
        try:
            lines = [
                f"{label} psm={psm} raw={raw!r} feet={ft:.4f} yds={yd:.4f}"
                for raw, ft, yd, _crop, psm, label in all_candidates
            ]
            (debug_dir / "latest_target_elevation_candidates.txt").write_text(
                "\n".join(lines), encoding="utf-8"
            )
        except Exception:
            pass

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


# Both v5's primary PIN read and target_cards_v6's PIN/AIM reads resolve this
# function at runtime, so one patch fixes elevation OCR for both card roles.
target_card._parse_elevation = _strict_parse_elevation
target_card.read_target_card = _read_target_card_v6

_original_read_screen_state = v5.read_screen_state
_last_cards: dict[str, target_card.TargetCardState] = {}
_last_cards_error: Exception | None = None


def read_screen_state_v6(screen, args: argparse.Namespace, debug_dir):
    global _last_cards, _last_cards_error

    state, distance, distance_source, target_error = _original_read_screen_state(
        screen,
        args,
        debug_dir,
    )

    if state is not None:
        state.source = "gspro-screen-pin-card"
        if args.distance is None:
            distance_source = state.source

    _last_cards = {}
    _last_cards_error = None
    try:
        _last_cards = target_cards_v6.read_cards(
            screen,
            tesseract_path=args.tesseract,
            debug_dir=debug_dir,
        )
        if state is not None:
            _last_cards["pin"] = state
    except Exception as exc:
        _last_cards_error = exc
        if state is not None:
            _last_cards["pin"] = state

    return state, distance, distance_source, target_error


def _state_text(state: target_card.TargetCardState | None) -> str:
    if state is None:
        return "not displayed"
    return f"{state.distance_yds:.0f} yd | {v5._elevation_text(state)}"


def print_result_v6(result, state, target_error: Exception | None, corridor: float) -> None:
    print()
    print("GSPro LIVE STATE + MINIMAP HAZARD PROBE v6")
    print("============================================")
    print(f"Pin target:          {result.distance_to_pin_yds:.1f} yd [{result.distance_source}]")
    print(f"Pin elevation:       {v5._elevation_text(state)}")
    print(f"GSPro aim target:    {_state_text(_last_cards.get('aim'))}")
    if _last_cards_error is not None:
        print(f"Aim-card warning:    {_last_cards_error}")
    if target_error is not None and result.distance_source == "CLI override":
        print(f"Pin-card warning:    {target_error}")
    print(f"Ball -> pin pixels:  {result.pixels_ball_to_pin:.1f} px")
    print(f"Map scale:           {result.yards_per_pixel:.4f} yd/px")
    print(f"Ball pixel:          ({result.ball_pixel.x:.1f}, {result.ball_pixel.y:.1f})")
    print(f"Pin pixel:           ({result.pin_pixel.x:.1f}, {result.pin_pixel.y:.1f})")
    print(f"Zoom retries used:   {result.zoom_retries_used}")
    print()
    print(f"Penalty objects ({len(result.penalty_objects)}):")
    if not result.penalty_objects:
        print("  None detected in visible minimap.")
        return

    for obj in result.penalty_objects:
        crossings = ", ".join(f"{x:.0f}" for x in obj.centerline_crossings_yds) or "none"
        corridor_text = (
            f"corridor {obj.corridor_entry_yds:.0f}-{obj.corridor_exit_yds:.0f} yd"
            if obj.corridor_entry_yds is not None and obj.corridor_exit_yds is not None
            else f"outside +/-{corridor:.0f} yd corridor"
        )
        print(
            f"  #{obj.object_id}: nearest {obj.nearest_yds:.0f} yd; "
            f"forward {obj.forward_min_yds:.0f}-{obj.forward_max_yds:.0f}; "
            f"mostly {v5.v2.side_text(obj.median_lateral_yds)}; {corridor_text}; "
            f"centerline red crossings [{crossings}]"
        )


v5.read_screen_state = read_screen_state_v6
v5.print_result = print_result_v6


if __name__ == "__main__":
    raise SystemExit(v5.main())
