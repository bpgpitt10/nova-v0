#!/usr/bin/env python3
"""Robust GSPro target-card detection for live full-shot play.

v5 tried to discover the card from its dark interior. On tree-lined / blind-shot
views the black card can visually merge with the dark course background, so that
approach can miss an obvious card.

v6 instead detects the BORDER, which is the stable UI signature:
- white border (+ white pointer tail) = permanent pin card;
- red border = currently selected / aim-point card.

The card body is screen-space UI and is roughly square. The white pointer tail is
much taller than the body, so for a white connected component we intentionally
crop only the square top portion. Red aim cards have a red square border while
the pointer tail remains white, so the red component is already approximately the
card body.
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


def _border_masks(screen: np.ndarray) -> dict[str, np.ndarray]:
    hsv = cv2.cvtColor(screen, cv2.COLOR_BGR2HSV)
    search = _search_mask(screen.shape[:2])

    white = (
        (hsv[:, :, 1] < 70)
        & (hsv[:, :, 2] > 170)
        & (search > 0)
    ).astype(np.uint8) * 255

    red = (
        (((hsv[:, :, 0] <= 12) | (hsv[:, :, 0] >= 168)))
        & (hsv[:, :, 1] > 110)
        & (hsv[:, :, 2] > 100)
        & (search > 0)
    ).astype(np.uint8) * 255

    return {"pin": white, "aim": red}


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

    # The actual GSPro card interior is extremely dark. This is the strongest
    # rejection for bright sky/building shapes that can also form white components.
    dark_ratio = float((inner < 90).mean())
    if dark_ratio < 0.72:
        return False, 0.0

    top = hsv[int(h * 0.08):int(h * 0.50), int(w * 0.10):int(w * 0.90)]
    white_text_ratio = float(((top[:, :, 1] < 80) & (top[:, :, 2] > 165)).mean()) if top.size else 0.0
    if white_text_ratio < 0.035:
        return False, 0.0

    lower_left = hsv[int(h * 0.48):int(h * 0.95), :int(w * 0.56)]
    green_ratio = float((
        (lower_left[:, :, 0] >= 35)
        & (lower_left[:, :, 0] <= 95)
        & (lower_left[:, :, 1] > 70)
        & (lower_left[:, :, 2] > 80)
    ).mean()) if lower_left.size else 0.0
    if green_ratio < 0.002:
        return False, 0.0

    # Score only needs to rank multiple plausible UI components.
    score = dark_ratio * 160.0 + white_text_ratio * 80.0 + min(green_ratio, 0.08) * 250.0
    return True, score


def detect_cards(screen: np.ndarray) -> list[DetectedCard]:
    H, W = screen.shape[:2]
    detected: list[DetectedCard] = []

    for card_type, raw_mask in _border_masks(screen).items():
        mask = cv2.morphologyEx(
            raw_mask,
            cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)),
        )
        mask = cv2.dilate(
            mask,
            cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
            iterations=1,
        )

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, rw, rh = cv2.boundingRect(contour)

            # Observed cards are ~5-7% of screen width; keep modest tolerance for
            # different monitor/render scaling.
            if not (W * 0.032 <= rw <= W * 0.095):
                continue

            if card_type == "pin":
                # White card border is connected to its long white pointer tail.
                if not (rw * 1.15 <= rh <= rw * 2.8):
                    continue
                card_h = int(round(rw * 1.02))
            else:
                # Red aim-card border is approximately square. Its pointer remains white.
                if not (rw * 0.72 <= rh <= rw * 1.42):
                    continue
                card_h = int(round(max(rh, rw * 0.95)))

            card_h = min(card_h, H - y)
            if card_h <= 0:
                continue

            # Small pad recovers anti-aliased border pixels while still excluding
            # almost all of the pointer tail.
            pad = max(1, int(round(H * 0.0015)))
            bx = max(0, x - pad)
            by = max(0, y - pad)
            bw = min(W - bx, rw + 2 * pad)
            bh = min(H - by, card_h + 2 * pad)
            bbox = (bx, by, bw, bh)

            valid, score = _validate_card_body(screen, bbox)
            if not valid:
                continue

            # Prefer normal card size and locations near the middle vertical region,
            # but do not require a particular horizontal position.
            size_bonus = max(0.0, 25.0 - abs(rw - W * 0.061) * 0.20)
            vertical_center = y + card_h / 2
            vertical_bonus = max(0.0, 12.0 - abs(vertical_center - H * 0.30) / max(H * 0.025, 1.0))
            detected.append(DetectedCard(card_type, bbox, score + size_bonus + vertical_bonus))

    # There should normally be at most one of each type. If rendering artifacts
    # create duplicates, keep the strongest candidate per type.
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
