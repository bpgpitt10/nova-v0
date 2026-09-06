#!/usr/bin/env python3
"""Robust GSPro target-card detection for live full-shot play.

v6 now uses the colored card BORDER as the primary detector:
- white border + white pointer tail = permanent PIN card;
- red square border = selected AIM card.

The earlier dark-interior classifier could find the red card but misclassify it as
white when its sampling ring missed the red pixels. It could also miss the white
card against dark/bright scenery. Direct raw-color connected components are much
cleaner for these UI elements as long as we avoid morphology that merges the white
border into scenery.

A dark-interior fallback remains for unusual anti-alias/render cases.
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

    top = hsv[int(h * 0.08):int(h * 0.52), int(w * 0.10):int(w * 0.90)]
    white_text_ratio = float(((top[:, :, 1] < 85) & (top[:, :, 2] > 160)).mean()) if top.size else 0.0
    if white_text_ratio < 0.025:
        return False, 0.0

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


def _direct_border_candidates(screen: np.ndarray) -> list[DetectedCard]:
    """Primary detector: raw UI border colors, intentionally with NO dilation/close."""
    H, W = screen.shape[:2]
    hsv = cv2.cvtColor(screen, cv2.COLOR_BGR2HSV)
    search = _search_mask((H, W)) > 0

    red = (
        (((hsv[:, :, 0] <= 12) | (hsv[:, :, 0] >= 168)))
        & (hsv[:, :, 1] > 110)
        & (hsv[:, :, 2] > 100)
        & search
    ).astype(np.uint8) * 255

    white = (
        (hsv[:, :, 1] < 70)
        & (hsv[:, :, 2] > 170)
        & search
    ).astype(np.uint8) * 255

    found: list[DetectedCard] = []

    # RED AIM CARD: the red component is the square body border. The pointer is white.
    contours, _ = cv2.findContours(red, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, rw, rh = cv2.boundingRect(contour)
        if not (W * 0.032 <= rw <= W * 0.095):
            continue
        aspect = rw / max(float(rh), 1.0)
        if not (0.76 <= aspect <= 1.28):
            continue
        area = cv2.contourArea(contour)
        if area < rw * rh * 0.20:
            continue

        pad = max(1, int(round(H * 0.0015)))
        bx = max(0, x - pad)
        by = max(0, y - pad)
        bw = min(W - bx, rw + 2 * pad)
        bh = min(H - by, rh + 2 * pad)
        bbox = (bx, by, bw, bh)

        valid, body_score = _validate_card_body(screen, bbox)
        if not valid:
            continue
        found.append(DetectedCard("aim", bbox, body_score + area / max(rw * rh, 1.0) * 30.0))

    # WHITE PIN CARD: border is connected to the long white pointer tail. The raw
    # component therefore has a card-sized width and is roughly 1.4-2.5x as tall.
    contours, _ = cv2.findContours(white, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, rw, rh = cv2.boundingRect(contour)
        if not (W * 0.032 <= rw <= W * 0.095):
            continue
        tall_ratio = rh / max(float(rw), 1.0)
        if not (1.28 <= tall_ratio <= 2.65):
            continue

        # Crop only the square card body at the TOP of the connected border+pointer.
        body_h = int(round(rw * 1.02))
        body_h = min(body_h, H - y)
        if body_h <= 0:
            continue

        pad = max(1, int(round(H * 0.0015)))
        bx = max(0, x - pad)
        by = max(0, y - pad)
        bw = min(W - bx, rw + 2 * pad)
        bh = min(H - by, body_h + 2 * pad)
        bbox = (bx, by, bw, bh)

        valid, body_score = _validate_card_body(screen, bbox)
        if not valid:
            continue

        # Strongly prefer the canonical pointer-tail shape over incidental white scenery.
        shape_bonus = max(0.0, 28.0 - abs(tall_ratio - 1.90) * 25.0)
        found.append(DetectedCard("pin", bbox, body_score + shape_bonus))

    return found


def _ring_classification(
    screen: np.ndarray,
    interior_bbox: tuple[int, int, int, int],
    pad: int,
) -> tuple[str | None, float, float]:
    """Fallback classifier for a square dark card interior."""
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
    red_ratio = float(((r - np.maximum(b, g) > 25) & (r > 140)).mean())
    spread = np.maximum.reduce([b, g, r]) - np.minimum.reduce([b, g, r])
    white_ratio = float(((spread < 45) & (np.maximum.reduce([b, g, r]) > 170)).mean())

    if red_ratio >= 0.018:
        return "aim", red_ratio, white_ratio
    if white_ratio >= 0.14:
        return "pin", red_ratio, white_ratio
    return None, red_ratio, white_ratio


def _interior_fallback_candidates(screen: np.ndarray, missing_types: set[str]) -> list[DetectedCard]:
    if not missing_types:
        return []

    H, W = screen.shape[:2]
    search = _search_mask((H, W))
    gray = cv2.cvtColor(screen, cv2.COLOR_BGR2GRAY)
    dark = ((gray < 78) & (search > 0)).astype(np.uint8) * 255
    contours, _ = cv2.findContours(dark, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    found: list[DetectedCard] = []
    for contour in contours:
        x, y, rw, rh = cv2.boundingRect(contour)
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
        if interior.size == 0 or float((interior < 92).mean()) < 0.78:
            continue

        pad = max(6, int(round(H * 0.008)))
        card_type, red_ratio, white_ratio = _ring_classification(screen, (x, y, rw, rh), pad)
        if card_type is None or card_type not in missing_types:
            continue

        bx = max(0, x - pad)
        by = max(0, y - pad)
        bw = min(W - bx, rw + 2 * pad)
        bh = min(H - by, rh + 2 * pad)
        bbox = (bx, by, bw, bh)
        valid, body_score = _validate_card_body(screen, bbox)
        if not valid:
            continue

        border_bonus = red_ratio * 200.0 if card_type == "aim" else white_ratio * 30.0
        found.append(DetectedCard(card_type, bbox, body_score + border_bonus))

    return found


def detect_cards(screen: np.ndarray) -> list[DetectedCard]:
    detected = _direct_border_candidates(screen)

    best: dict[str, DetectedCard] = {}
    for item in detected:
        current = best.get(item.card_type)
        if current is None or item.score > current.score:
            best[item.card_type] = item

    missing = {"pin", "aim"} - set(best)
    for item in _interior_fallback_candidates(screen, missing):
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
