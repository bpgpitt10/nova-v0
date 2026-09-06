#!/usr/bin/env python3
"""GSPro live-state + minimap hazard probe v6.

v6 fixes target-card discovery by detecting the stable UI border rather than the
dark card interior, and understands both GSPro card roles:
- white PIN card: permanent distance/elevation anchor;
- red AIM card: current selected/default aim-point distance/elevation when shown.

This version intentionally does NOT synthesize L/R aim input yet. First prove that
both cards can be detected/read reliably without altering the player's aim. The
next step can reuse the calibrated duration-based aim actuator pattern from the
putting auto-aim project.
"""

from __future__ import annotations

import argparse

import probe_v5 as v5
import target_card
import target_cards_v6


# v5's read_target_card() calls this global when no debug ROI is supplied. Patch it
# to the new border-based white PIN-card detector.
target_card.detect_target_card = target_cards_v6.detect_pin_bbox

_original_read_screen_state = v5.read_screen_state
_last_cards: dict[str, target_card.TargetCardState] = {}
_last_cards_error: Exception | None = None


def read_screen_state_v6(screen, args: argparse.Namespace, debug_dir):
    global _last_cards, _last_cards_error

    # Primary pin-card read follows v5's existing distance-override/error behavior,
    # but now uses the robust v6 pin-card locator patched above.
    state, distance, distance_source, target_error = _original_read_screen_state(
        screen,
        args,
        debug_dir,
    )

    if state is not None:
        state.source = "gspro-screen-pin-card"
        if args.distance is None:
            distance_source = state.source

    # Independently inspect all visible target cards. A red aim card is optional;
    # its absence must never fail the live shot.
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


# v5.main() resolves these functions from its module globals at runtime.
v5.read_screen_state = read_screen_state_v6
v5.print_result = print_result_v6


if __name__ == "__main__":
    raise SystemExit(v5.main())
