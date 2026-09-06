#!/usr/bin/env python3
"""Robust GSPro target-card detection for live full-shot play.

v6 originally tried to find cards from the colored border component. On tree-lined
views the white pin border can connect to bright background pixels, which shifts the
component's top edge upward and causes OCR to crop the wrong place.

This version instead finds the card's enclosed DARK INTERIOR with RETR_LIST. The
interior remains a clean, almost-square contour even when the outer white border is
visually connected to trees/sky. We then inspect a thin ring around that interior to
classify the card:
- white/neutral ring = permanent PIN card;
- red-tinted ring = selected AIM card.

The card body is screen-space UI. We expand the dark interior by a small fixed-scale
padding to recover the border, then reuse target_card.py for OCR + elevation parsing.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

import target_card


@dataclass
class DetectedCard:
    card_type: str  # "pin" or "aim"
    bbox: tuple[int, int, int, int]
    score: float


def _search_mask(shape: tuple[int, int]) -> np.ndarray:
    h, w = shape
    mask = np.zeros((h, w), dtype=np.uint8)
    # Central 3D course view. Keeps top HUD and side data panels out while allowing
    # cards to appear well left/right of the centerline.
    cv2.rectangle(
        mask,
        (int(w * 0.17), int(h * 0.11)),
        (int(w * 0.84), int(h * 0.72)),
        255,
        -1,
    )
    return mask


def _validate_card_body(screen: np.ndarray, bbox: tuple[int, int, int, int]) -> tuple[bool, float]:
    x, y, w, h = bbox
    card = screen[y:y + h, x:x + w]
    if card.size == 0:
        return False, 0.0

    hsv = cv2.cvtColor(card, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)

    inner = gray[int(h * 0.10):int(h * 0.92), int(w * 0.08):int(w * 0.92)]
    if inner.size == 0:
        return False, 0.0

    dark_ratio = float((inner < 90).mean())
    if dark_ratio < 0.62:
        return False, 0.0

    # Large white distance numerals should exist in the upper half.
    top = hsv[int(h * 0.08):int(h * 0.52), int(w * 0.10):int(w * 0.90)]
    white_text_ratio = float(((top[:, :, 1] < 85) & (top[:, :, 2] > 160)).mean()) if top.size else 0.0
    if white_text_ratio < 0.025:
        return False, 0.0

    # Every full-shot target card has the green elevation triangle in the lower-left.
    lower_left = hsv[int(h * 0.46):int(h * 0.96), :int(w * 0.58)]
    green_ratio = float((
        (lower_left[:, :, 0] >= 35)
        & (lower_left[:, :, 0] <= 95)
        & (lower_left[:, :, 1] > 65)
        & (lower_left[:, :, 2] > 75)
    ).mean()) if lower_left.size else 0.0
    if green_ratio < 0.0015:
        return False, 0.0

    score = dark_ratio * 150.0 + white_text_ratio * 90.0 + min(green_ratio, 0.08) * 260.0
    return True, score


def _ring_classification(
    screen: np.ndarray,
    interior_bbox: tuple[int, int, int, int],
    pad: int,
) -> tuple[str | None, float, float]:
    """Return (type, red_ratio, white_ratio) from pixels just outside dark interior."""
    H, W = screen.shape[:2]
    x, y, w, h = interior_bbox

    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(W, x + w + pad)
    y1 = min(H, y + h + pad)
    outer = screen[y0:y1, x0:x1]
    if outer.size == 0:
        return None, 0.0, 0.0

    mask = np.ones(outer.shape[:2], dtype=bool)
    ix = x - x0
    iy = y - y0
    mask[iy:iy + h, ix:ix + w] = False
    pixels = outer[mask].astype(np.int16)
    if pixels.size == 0:
        return None, 0.0, 0.0

    b = pixels[:, 0]
    g = pixels[:, 1]
    r = pixels[:, 2]

    # GSPro's red border is strongly red at its core but heavily anti-aliased around
    # the edge. Relative RGB is more robust than requiring high HSV saturation.
    red_ratio = float(((r - np.maximum(b, g) > 25) & (r > 140)).mean())

    spread = np.maximum.reduce([b, g, r]) - np.minimum.reduce([b, g, r])
    white_ratio = float(((spread < 45) & (np.maximum.reduce([b, g, r]) > 170)).mean())

    # In observed captures a red aim card has ~6-12% red-tinted pixels in the close
    # ring while the white pin card is essentially 0% red. Keep the threshold loose
    # enough for anti-aliasing / render scaling.
    if red_ratio >= 0.025:
        return "aim", red_ratio, white_ratio
    if white_ratio >= 0.20:
        return "pin", red_ratio, white_ratio
    return None, red_ratio, white_ratio


def detect_cards(screen: np.ndarray) -> list[DetectedCard]:
    H, W = screen.shape[:2]
    search = _search_mask((H, W))
    gray = cv2.cvtColor(screen, cv2.COLOR_BGR2GRAY)

    # IMPORTANT: RETR_LIST is intentional. A pin card can sit in front of dark trees,
    # so its dark interior may be nested inside a much larger dark background contour.
    # RETR_EXTERNAL loses the card; RETR_LIST preserves the enclosed square interior.
    dark = ((gray < 78) & (search > 0)).astype(np.uint8) * 255
    contours, _ = cv2.findContours(dark, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    detected: list[DetectedCard] = []
    for contour in contours:
        x, y, rw, rh = cv2.boundingRect(contour)

        # Observed dark interiors are roughly 5-6% of screen width and ~10% of
        # screen height on 16:9-ish captures. Keep broader tolerances for scaling.
        if not (W * 0.028 <= rw <= W * 0.090):
            continue
        if not (H * 0.045 <= rh <= H * 0.145):
            continue

        aspect = rw / max(float(rh), 1.0)
        if not (0.72 <= aspect <= 1.32):
            continue

        area = cv2.contourArea(contour)
        rectangularity = area / max(float(rw * rh), 1.0)
        if rectangularity < 0.72:
            continue

        interior = gray[y:y + rh, x:x + rw]
        if interior.size == 0:
            continue
        interior_dark = float((interior < 92).mean())
        if interior_dark < 0.78:
            continue

        # Padding around the dark interior recovers the visible border/card body.
        # ~0.6% of screen height is 7px at 1150p and matched observed GSPro cards.
        pad = max(5, int(round(H * 0.006)))
        card_type, red_ratio, white_ratio = _ring_classification(
            screen, (x, y, rw, rh), max(3, pad // 2)
        )
        if card_type is None:
            continue

        bx = max(0, x - pad)
        by = max(0, y - pad)
        bw = min(W - bx, rw + 2 * pad)
        bh = min(H - by, rh + 2 * pad)
        bbox = (bx, by, bw, bh)

        valid, body_score = _validate_card_body(screen, bbox)
        if not valid:
            continue

        size_target = W * 0.055
        size_bonus = max(0.0, 22.0 - abs(rw - size_target) * 0.16)
        vertical_center = y + rh / 2
        vertical_bonus = max(0.0, 10.0 - abs(vertical_center - H * 0.28) / max(H * 0.03, 1.0))
        border_bonus = red_ratio * 180.0 if card_type == "aim" else white_ratio * 22.0

        detected.append(
            DetectedCard(card_type, bbox, body_score + size_bonus + vertical_bonus + border_bonus)
        )

    # There should normally be one pin and zero/one aim card. Keep the strongest
    # candidate per type if scenery creates additional square dark candidates.
    best: dict[str, DetectedCard] = {}
    for item in detected:
        current = best.get(item.card_type)
        if current is None or item.score > current.score:
            best[item.card_type] = item

    return [best[k] for k in ("pin", "aim") if k in best]


def detect_pin_bbox(screen: np.ndarray) -> tuple[int, int, int, int]:
    for card in detect_cards(screen):
        if card.card_type == "pin":
            return card.bbox
    raise RuntimeError("Could not locate the white GSPro pin target card.")


def detect_aim_bbox(screen: np.ndarray) -> tuple[int, int, int, int]:
    for card in detect_cards(screen):
        if card.card_type == "aim":
            return card.bbox
    raise RuntimeError("Could not locate a red GSPro aim target card.")


def _read_bbox(
    screen: np.ndarray,
    card: DetectedCard,
    tesseract_path: str | None,
) -> target_card.TargetCardState:
    state = target_card.read_target_card(
        screen,
        tesseract_path=tesseract_path,
        bbox_override=card.bbox,
        debug_dir=None,
    )
    state.source = "gspro-screen-pin-card" if card.card_type == "pin" else "gspro-screen-aim-card"
    return state


def read_cards(
    screen: np.ndarray,
    tesseract_path: str | None = None,
    debug_dir: Path | None = None,
) -> dict[str, target_card.TargetCardState]:
    states: dict[str, target_card.TargetCardState] = {}
    detected = detect_cards(screen)

    for card in detected:
        try:
            states[card.card_type] = _read_bbox(screen, card, tesseract_path)
        except Exception:
            # Detection and OCR are deliberately separable. A bad OCR read on an
            # optional red card should not make the permanent white pin card vanish.
            continue

    if debug_dir is not None:
        debug_dir.mkdir(parents=True, exist_ok=True)
        annotated = screen.copy()
        for card in detected:
            x, y, w, h = card.bbox
            color = (255, 255, 255) if card.card_type == "pin" else (0, 0, 255)
            cv2.rectangle(annotated, (x, y), (x + w, y + h), color, 2)
            state = states.get(card.card_type)
            if state is not None:
                text = f"{card.card_type}: {state.distance_yds:.0f} yd {state.elevation_direction} {state.elevation_raw or '?'}"
            else:
                text = f"{card.card_type}: detected / OCR failed"
            cv2.putText(
                annotated,
                text,
                (x, max(24, y - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.58,
                color,
                2,
                cv2.LINE_AA,
            )
            crop = screen[y:y + h, x:x + w]
            cv2.imwrite(str(debug_dir / f"latest_{card.card_type}_card_v6.png"), crop)

        cv2.imwrite(str(debug_dir / "latest_target_cards_v6.png"), annotated)

    return states
