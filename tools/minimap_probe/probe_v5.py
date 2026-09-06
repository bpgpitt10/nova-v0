#!/usr/bin/env python3
"""
GSPro live-state + minimap hazard probe v5.

Adds the missing pre-shot state source:
- auto-detect the white-bordered GSPro target card in the 3D view;
- OCR distance from its top line;
- detect elevation direction from the green triangle;
- OCR elevation from its bottom line (yards or feet/inches);
- use the screen distance directly for minimap calibration, including tee shots.

Manual --distance remains only as a debugging fallback/override.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2

import probe as base
import probe_v2 as v2
import probe_v4  # noqa: F401; applies v3 marker + v4 hazard-crossing patches to v2
import target_card


@dataclass
class LiveProbeResult:
    distance_to_pin_yds: float
    distance_source: str
    elevation_raw: str | None
    elevation_direction: str | None
    elevation_delta_ft: float | None
    elevation_delta_yds: float | None
    elevation_source: str | None
    ball_pixel: base.Point
    pin_pixel: base.Point
    pixels_ball_to_pin: float
    yards_per_pixel: float
    penalty_objects: list[v2.PenaltyObject]
    zoom_retries_used: int


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GSPro live-state + minimap hazard probe v5")
    p.add_argument("--distance", type=float,
                   help="Optional manual distance override. Screen target card is primary when omitted.")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi", help="Override minimap crop as x,y,w,h in screen pixels.")
    p.add_argument("--target-card-roi", help="Debug override for target card crop as x,y,w,h in screen pixels.")
    p.add_argument("--tesseract", help="Explicit path to tesseract.exe if auto-discovery fails.")
    p.add_argument("--corridor", type=float, default=40.0)
    p.add_argument("--centerline-band", type=float, default=4.0)
    p.add_argument("--merge-gap", type=float, default=4.0)
    p.add_argument("--zoom-out-key", choices=["w", "W"], default="W")
    p.add_argument("--zoom-attempts", type=int, default=4)
    p.add_argument("--debug-dir", default=str(Path(__file__).with_name("output")))
    p.add_argument("--json", action="store_true")
    return p.parse_args()


def parse_bbox(text: str | None) -> tuple[int, int, int, int] | None:
    if not text:
        return None
    parts = [int(x.strip()) for x in text.split(",")]
    if len(parts) != 4:
        raise ValueError("ROI must be x,y,w,h")
    return tuple(parts)  # type: ignore[return-value]


def _fixed_ocr(image, tesseract_exe: str, whitelist: str, psm: str = "7") -> str:
    """Windows-safe Tesseract subprocess used by target_card.read_target_card()."""
    prepared = target_card._prep_ocr(image)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        cv2.imwrite(tmp_path, prepared)
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        completed = subprocess.run(
            [
                tesseract_exe,
                tmp_path,
                "stdout",
                "--psm",
                psm,
                "-c",
                f"tessedit_char_whitelist={whitelist}",
            ],
            capture_output=True,
            text=True,
            creationflags=creationflags,
            timeout=8,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or f"Tesseract exited {completed.returncode}")
        return completed.stdout.strip()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# Fix the target-card module's subprocess call without duplicating its detection/parser code.
target_card._ocr = _fixed_ocr


def read_screen_state(screen, args: argparse.Namespace, debug_dir: Path):
    target_error: Exception | None = None
    state = None
    try:
        state = target_card.read_target_card(
            screen,
            tesseract_path=args.tesseract,
            bbox_override=parse_bbox(args.target_card_roi),
            debug_dir=debug_dir,
        )
    except Exception as exc:
        target_error = exc

    if args.distance is not None:
        if args.distance <= 0:
            raise RuntimeError("--distance must be > 0")
        distance = float(args.distance)
        distance_source = "CLI override"
    elif state is not None:
        distance = float(state.distance_yds)
        distance_source = state.source
    else:
        raise RuntimeError(
            f"Could not read screen target distance and no --distance override was supplied: {target_error}"
        )

    return state, distance, distance_source, target_error


def detect_minimap_with_zoom(
    initial_screen,
    distance: float,
    args: argparse.Namespace,
):
    retries = 0
    screen = initial_screen
    last_error: Exception | None = None

    while True:
        roi, _ = base.crop_minimap(screen, args.roi)
        try:
            ball = v2.detect_ball_marker(roi)
            pin = v2.detect_pin_marker(roi)
            sep = math.hypot(pin.x - ball.x, pin.y - ball.y)
            scale = distance / sep if sep > 0 else 999.0
            if sep < 20 or not (0.03 <= scale <= 3.0):
                raise RuntimeError(
                    f"Marker pair failed geometry sanity check: sep={sep:.1f}px scale={scale:.3f}"
                )
            return roi, ball, pin, retries, screen
        except Exception as exc:
            last_error = exc

        if not args.zoom_out_key or retries >= args.zoom_attempts:
            raise RuntimeError(f"Could not get reliable ball/pin markers: {last_error}")

        v2.press_key_windows(args.zoom_out_key)
        retries += 1
        time.sleep(0.35)
        screen = base.capture_monitor(args.monitor)


def _elevation_text(state) -> str:
    if state is None:
        return "unavailable"
    if state.elevation_delta_ft is None:
        raw = state.elevation_raw or "?"
        return f"{state.elevation_direction} {raw} (OCR captured; normalization unresolved)"

    amount = abs(state.elevation_delta_ft)
    signed = state.elevation_delta_ft
    return (
        f"{state.elevation_direction} {state.elevation_raw or '?'} "
        f"({signed:+.2f} ft / {signed / 3.0:+.2f} yd)"
    )


def print_result(result: LiveProbeResult, state, target_error: Exception | None, corridor: float) -> None:
    print()
    print("GSPro LIVE STATE + MINIMAP HAZARD PROBE v5")
    print("============================================")
    print(f"Distance:           {result.distance_to_pin_yds:.1f} yd [{result.distance_source}]")
    print(f"Elevation:          {_elevation_text(state)}")
    if target_error is not None and result.distance_source == "CLI override":
        print(f"Target-card warning: {target_error}")
    print(f"Ball -> pin pixels: {result.pixels_ball_to_pin:.1f} px")
    print(f"Map scale:          {result.yards_per_pixel:.4f} yd/px")
    print(f"Ball pixel:         ({result.ball_pixel.x:.1f}, {result.ball_pixel.y:.1f})")
    print(f"Pin pixel:          ({result.pin_pixel.x:.1f}, {result.pin_pixel.y:.1f})")
    print(f"Zoom retries used:  {result.zoom_retries_used}")
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
            else f"outside ±{corridor:.0f} yd corridor"
        )
        print(
            f"  #{obj.object_id}: nearest {obj.nearest_yds:.0f} yd; "
            f"forward {obj.forward_min_yds:.0f}-{obj.forward_max_yds:.0f}; "
            f"mostly {v2.side_text(obj.median_lateral_yds)}; {corridor_text}; "
            f"centerline red crossings [{crossings}]"
        )


def main() -> int:
    args = parse_args()
    debug_dir = Path(args.debug_dir)
    debug_dir.mkdir(parents=True, exist_ok=True)

    try:
        initial_screen = base.capture_monitor(args.monitor)
        state, distance, distance_source, target_error = read_screen_state(initial_screen, args, debug_dir)

        roi, ball, pin, retries, final_screen = detect_minimap_with_zoom(
            initial_screen,
            distance,
            args,
        )

        # If zoom recovery recaptured the screen, update the target-card debug image
        # from the final screen too. Distance/elevation should not change from W.
        if retries > 0 and args.distance is None:
            try:
                refreshed = target_card.read_target_card(
                    final_screen,
                    tesseract_path=args.tesseract,
                    bbox_override=parse_bbox(args.target_card_roi),
                    debug_dir=debug_dir,
                )
                # Only accept the refresh when it agrees closely on distance.
                if abs(refreshed.distance_yds - distance) <= 2:
                    state = refreshed
            except Exception:
                pass

        objects, pin_pixels, scale = v2.build_penalty_objects(
            roi=roi,
            ball=ball,
            pin=pin,
            distance_to_pin_yds=distance,
            corridor_half_width_yds=args.corridor,
            centerline_band_yds=args.centerline_band,
            merge_gap_yds=args.merge_gap,
        )

        result = LiveProbeResult(
            distance_to_pin_yds=distance,
            distance_source=distance_source,
            elevation_raw=state.elevation_raw if state else None,
            elevation_direction=state.elevation_direction if state else None,
            elevation_delta_ft=state.elevation_delta_ft if state else None,
            elevation_delta_yds=state.elevation_delta_yds if state else None,
            elevation_source=state.source if state else None,
            ball_pixel=ball,
            pin_pixel=pin,
            pixels_ball_to_pin=pin_pixels,
            yards_per_pixel=scale,
            penalty_objects=objects,
            zoom_retries_used=retries,
        )

        debug = v2.write_debug(roi, ball, pin, objects, scale, distance, debug_dir)

        if args.json:
            print(json.dumps(asdict(result), indent=2))
        else:
            print_result(result, state, target_error, args.corridor)
            print(f"\nMinimap debug:     {debug}")
            if state is not None:
                print(f"Target-card debug: {debug_dir / 'latest_screen_target_debug.png'}")
                print(f"Target-card crop:  {debug_dir / 'latest_target_card.png'}")
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
