#!/usr/bin/env python3
"""Read GSPro's directional lie slope from the minimap footer.

GSPro displays two always-visible lie components at the bottom of the minimap:
- longitudinal slope: e.g. 2.3° UP / 28.9° DOWN
- lateral slope: e.g. 0.6° LEFT / 0.2° RIGHT

This is different from target elevation on the PIN/AIM cards. Target elevation is
ball-to-target vertical change; lie slope describes the ground under the ball.

The reader is intentionally non-fatal for the live probe. If OCR fails, the probe
can still return distance/elevation/hazard state and preserve a debug crop.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import cv2

import target_card


# Normalized against the full GSPro monitor. This matches the same right-side
# minimap layout already used by probe.DEFAULT_ROI, extended through the footer.
DEFAULT_LIE_FOOTER_ROI = (0.848, 0.952, 0.997, 0.999)


@dataclass
class LieState:
    up_down_deg: float
    up_down_direction: str
    left_right_deg: float
    left_right_direction: str
    signed_up_down_deg: float
    signed_left_right_deg: float
    up_down_ocr_raw: str
    left_right_ocr_raw: str
    footer_bbox: tuple[int, int, int, int]
    source: str = "gspro-screen-minimap-lie"


def _parse_override(text: str | None) -> tuple[int, int, int, int] | None:
    if not text:
        return None
    parts = [int(x.strip()) for x in text.split(",")]
    if len(parts) != 4:
        raise ValueError("--lie-roi must be x,y,w,h")
    return tuple(parts)  # type: ignore[return-value]


def _footer_bbox(screen, override: str | None = None) -> tuple[int, int, int, int]:
    H, W = screen.shape[:2]
    explicit = _parse_override(override)
    if explicit is not None:
        x, y, w, h = explicit
    else:
        x1, y1, x2, y2 = DEFAULT_LIE_FOOTER_ROI
        x = int(round(W * x1))
        y = int(round(H * y1))
        w = int(round(W * x2)) - x
        h = int(round(H * y2)) - y

    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > W or y + h > H:
        raise RuntimeError(f"Invalid lie footer ROI {(x, y, w, h)} for screen {W}x{H}")
    return x, y, w, h


def _display_precision(value: float) -> float:
    """Normalize to GSPro's one-decimal lie display precision."""
    return round(float(value), 1)


def _parse_display_number(raw: str) -> float | None:
    """Parse the displayed one-decimal lie value without trusting OCR junk after it.

    GSPro renders exactly one decimal place followed immediately by a degree symbol.
    Tesseract often turns that degree symbol into another digit (for example visible
    `2.8°` -> `2.89`, or `2.5°` -> `2.52`). Rounding the hallucinated number can
    therefore change the true displayed value. Preserve only the first decimal digit.
    """
    compact = re.sub(r"\s+", "", raw)
    m = re.search(r"(\d{1,2})\.(\d)", compact)
    if m:
        value = float(f"{m.group(1)}.{m.group(2)}")
        return value if 0.0 <= value <= 60.0 else None

    # Integer zero is useful as a fallback on perfectly flat lies; do not invent a
    # decimal location for other multi-digit OCR strings.
    if compact in ("0", "00"):
        return 0.0
    return None


def _parse_direction(raw: str) -> str | None:
    compact = re.sub(r"\s+", "", raw).upper()
    m = re.search(r"UP|DOWN|LEFT|RIGHT", compact)
    return m.group(0).lower() if m else None


def _ocr_component(crop, tess: str) -> tuple[str, float | None, str | None]:
    """Read one GSPro lie component using separate numeric and direction crops.

    Field testing showed that OCRing the whole component let the degree glyph alter
    the final digit (`2.8° DOWN` was read as `2.0 DOWN`). The UI layout is stable, so
    value and direction are read independently, then recombined. The legacy whole-
    component passes remain only as a fallback.
    """
    width = crop.shape[1]
    number_crop = crop[:, : max(1, int(width * 0.53))]
    direction_crop = crop[:, min(width - 1, int(width * 0.42)) :]

    # These settings were validated against the first live fairway capture:
    # numeric PSM 6 read visible 2.8° as `2.89` and 2.5° as `2.5`; parsing only the
    # first decimal digit recovers the exact GSPro display. Direction PSM 7 cleanly
    # read DOWN / RIGHT on the same frame.
    number_raw = target_card._ocr(number_crop, tess, "0123456789.", psm="6").strip().upper()
    direction_raw = target_card._ocr(
        direction_crop,
        tess,
        "UPDOWNLEFTRIGHT",
        psm="7",
    ).strip().upper()
    value = _parse_display_number(number_raw)
    direction = _parse_direction(direction_raw)
    combined_raw = f"{number_raw} {direction_raw}".strip()
    if value is not None and direction is not None:
        return combined_raw, _display_precision(value), direction

    # Fallback for unusual rendering/scaling. Keep value and direction independent
    # across passes rather than requiring one OCR string to get both right.
    best_raw = combined_raw
    best_value = value
    best_direction = direction
    whitelist = "0123456789.UPDOWNLEFTRIGHT"
    for psm in ("7", "6", "11", "13"):
        raw = target_card._ocr(crop, tess, whitelist, psm=psm).strip().upper()
        if raw and not best_raw:
            best_raw = raw
        if best_value is None:
            best_value = _parse_display_number(raw)
        if best_direction is None:
            best_direction = _parse_direction(raw)
        if best_value is not None and best_direction is not None:
            return raw or best_raw, _display_precision(best_value), best_direction

    return best_raw, best_value, best_direction


def _signed(value: float, direction: str) -> float:
    # Positive conventions make downstream shot modeling simple:
    # + longitudinal = uphill; + lateral = right side / slope to the right.
    if direction in ("down", "left"):
        return -value
    return value


def read_lie_state(
    screen,
    tesseract_path: str | None = None,
    roi_override: str | None = None,
    debug_dir: Path | None = None,
) -> LieState:
    bbox = _footer_bbox(screen, roi_override)
    x, y, w, h = bbox
    footer = screen[y:y + h, x:x + w].copy()
    if footer.size == 0:
        raise RuntimeError("Lie footer crop was empty")

    tess = target_card._resolve_tesseract(tesseract_path)

    # GSPro places longitudinal lie on the left half and lateral lie on the right.
    # Leave a little overlap around center because the text can shift by a few px.
    left = footer[:, : int(w * 0.56)]
    right = footer[:, int(w * 0.44):]

    left_raw, up_down, up_down_dir = _ocr_component(left, tess)
    right_raw, left_right, left_right_dir = _ocr_component(right, tess)

    # Reject cross-component direction hallucinations. OCR occasionally reads the
    # neighboring word when the halves overlap.
    if up_down_dir not in ("up", "down"):
        up_down = None
        up_down_dir = None
    if left_right_dir not in ("left", "right"):
        left_right = None
        left_right_dir = None

    # A perfectly flat tee often reads the number more reliably than the short word.
    # If OCR got 0.0 but dropped direction, direction is mathematically irrelevant;
    # keep canonical UP/RIGHT so the shot state is still useful.
    if up_down is None:
        parsed = _parse_display_number(left_raw)
        if parsed == 0.0:
            up_down, up_down_dir = 0.0, "up"
    if left_right is None:
        parsed = _parse_display_number(right_raw)
        if parsed == 0.0:
            left_right, left_right_dir = 0.0, "right"

    if up_down is None or up_down_dir is None or left_right is None or left_right_dir is None:
        raise RuntimeError(
            "Could not parse minimap lie footer "
            f"(up/down OCR={left_raw!r}, left/right OCR={right_raw!r})"
        )

    state = LieState(
        up_down_deg=up_down,
        up_down_direction=up_down_dir,
        left_right_deg=left_right,
        left_right_direction=left_right_dir,
        signed_up_down_deg=_signed(up_down, up_down_dir),
        signed_left_right_deg=_signed(left_right, left_right_dir),
        up_down_ocr_raw=left_raw,
        left_right_ocr_raw=right_raw,
        footer_bbox=bbox,
    )

    if debug_dir is not None:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "latest_lie_footer.png"), footer)
        cv2.imwrite(str(debug_dir / "latest_lie_up_down_ocr.png"), target_card._prep_ocr(left, scale=5))
        cv2.imwrite(str(debug_dir / "latest_lie_left_right_ocr.png"), target_card._prep_ocr(right, scale=5))

        annotated = screen.copy()
        cv2.rectangle(annotated, (x, y), (x + w, y + h), (0, 255, 255), 2)
        label = (
            f"lie {up_down:.1f} {up_down_dir.upper()} | "
            f"{left_right:.1f} {left_right_dir.upper()}"
        )
        cv2.putText(
            annotated,
            label,
            (max(5, x - 260), max(25, y - 10)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (0, 255, 255),
            2,
            cv2.LINE_AA,
        )
        cv2.imwrite(str(debug_dir / "latest_screen_lie_debug.png"), annotated)

    return state


def state_text(state: LieState | None) -> str:
    if state is None:
        return "unavailable"
    return (
        f"{state.up_down_deg:.1f} deg {state.up_down_direction.upper()} | "
        f"{state.left_right_deg:.1f} deg {state.left_right_direction.upper()}"
    )
