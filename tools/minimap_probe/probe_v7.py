#!/usr/bin/env python3
"""GSPro live-state + minimap hazard probe v7.

v7 turns the successful screen/minimap POC into a closer approximation of live
round behavior. It keeps the white PIN card as the stable distance/elevation anchor
and, when the player-colored AIM card is not already visible, briefly exposes it with
matched duration-controlled L/R aim pulses.

Read-only safety matters: the probe verifies GSPro owns keyboard focus, returns with
the same-duration opposite pulse, measures residual scene shift, and only applies a
small bounded corrective pulse when visual feedback is reliable.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import aim_actuator
import probe_v5 as v5
import probe_v6 as v6
import target_card
import target_cards_v6


# Importing v6 applies the v6 target-card hooks to v5. Keep direct references so v7
# can layer AIM summon around them without creating recursive monkey-patches.
_v6_read_screen_state = v6.read_screen_state_v6
_last_aim_summon: aim_actuator.AimSummonResult | None = None


def parse_args_v7() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GSPro live-state + minimap hazard probe v7")
    p.add_argument(
        "--distance",
        type=float,
        help="Optional manual distance override. White PIN card is primary when omitted.",
    )
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi", help="Override minimap crop as x,y,w,h in screen pixels.")
    p.add_argument("--target-card-roi", help="Debug override for PIN target card crop as x,y,w,h.")
    p.add_argument("--tesseract", help="Explicit path to tesseract.exe if auto-discovery fails.")
    p.add_argument("--corridor", type=float, default=40.0)
    p.add_argument("--centerline-band", type=float, default=4.0)
    p.add_argument("--merge-gap", type=float, default=4.0)
    p.add_argument("--zoom-out-key", choices=["w", "W"], default="W")
    p.add_argument("--zoom-attempts", type=int, default=4)
    p.add_argument("--debug-dir", default=str(Path(__file__).with_name("output")))
    p.add_argument("--json", action="store_true")

    p.add_argument(
        "--no-aim-summon",
        action="store_true",
        help="Do not send L/R when the player-colored AIM card is absent.",
    )
    p.add_argument("--aim-pulse-ms", type=float, default=45.0)
    p.add_argument("--aim-settle-ms", type=float, default=180.0)
    p.add_argument("--aim-return-tolerance-px", type=float, default=1.5)
    p.add_argument("--aim-max-correction-ms", type=float, default=20.0)
    p.add_argument("--aim-max-corrections", type=int, default=2)
    return p.parse_args()


def read_screen_state_v7(screen, args: argparse.Namespace, debug_dir: Path):
    """Read PIN/AIM, auto-summoning AIM only when it is initially absent."""
    global _last_aim_summon

    state, distance, distance_source, target_error = _v6_read_screen_state(
        screen,
        args,
        debug_dir,
    )

    baseline_pin = v6._last_cards.get("pin")
    baseline_aim = v6._last_cards.get("aim")

    if baseline_aim is not None:
        _last_aim_summon = aim_actuator.AimSummonResult(
            attempted=False,
            existing=True,
            final_screen=screen,
        )
        return state, distance, distance_source, target_error

    if args.no_aim_summon:
        _last_aim_summon = aim_actuator.AimSummonResult(
            attempted=False,
            existing=False,
            warning="Automatic AIM-card summon disabled by --no-aim-summon.",
            final_screen=screen,
        )
        return state, distance, distance_source, target_error

    _last_aim_summon = aim_actuator.summon_aim_card(
        initial_screen=screen,
        capture_fn=lambda: v5.base.capture_monitor(args.monitor),
        pulse_ms=args.aim_pulse_ms,
        settle_ms=args.aim_settle_ms,
        return_tolerance_px=args.aim_return_tolerance_px,
        max_correction_ms=args.aim_max_correction_ms,
        max_corrections=args.aim_max_corrections,
        debug_dir=debug_dir,
    )

    final_screen = _last_aim_summon.final_screen
    if final_screen is not None:
        try:
            final_cards = target_cards_v6.read_cards(
                final_screen,
                tesseract_path=args.tesseract,
                debug_dir=debug_dir,
            )
            # PIN from the initial screenshot remains the authoritative calibration
            # anchor for this probe. The returned screen should agree, but a temporary
            # OCR miss must not erase a valid initial PIN read.
            if baseline_pin is not None:
                final_cards["pin"] = baseline_pin
            v6._last_cards = final_cards
        except Exception as exc:
            # Preserve the initial PIN even if final-card parsing fails.
            v6._last_cards = {"pin": baseline_pin} if baseline_pin is not None else {}
            v6._last_cards_error = exc

    if v6._last_cards.get("aim") is None:
        extra = "AIM card was not readable after controlled L/R summon."
        if _last_aim_summon.warning:
            _last_aim_summon.warning = f"{_last_aim_summon.warning} {extra}"
        else:
            _last_aim_summon.warning = extra

    return state, distance, distance_source, target_error


def _aim_status_text() -> str:
    status = _last_aim_summon
    if status is None:
        return "not attempted"
    if status.existing:
        return "already visible; no keyboard input sent"
    if not status.attempted:
        return "not attempted"
    if v6._last_cards.get("aim") is not None:
        return "auto-summoned with controlled L/R"
    return "summon attempted; AIM card not read"


def _return_text() -> str:
    status = _last_aim_summon
    if status is None or status.existing or not status.attempted:
        return "n/a"
    residual = status.residual_dx_px
    residual_text = f"{residual:+.2f} px" if residual is not None else "unknown"
    if status.verified is True:
        return f"PASS (residual {residual_text})"
    if status.verified is False:
        return f"OUTSIDE TOLERANCE (residual {residual_text})"
    return f"UNVERIFIED (residual {residual_text})"


def _correction_text() -> str:
    status = _last_aim_summon
    if status is None or not status.corrections:
        return "none"
    return ", ".join(f"{c.key} {c.duration_ms:.1f} ms" for c in status.corrections)


def print_result_v7(result, state, target_error: Exception | None, corridor: float) -> None:
    print()
    print("GSPro LIVE STATE + MINIMAP HAZARD PROBE v7")
    print("============================================")
    print(f"Pin target:          {result.distance_to_pin_yds:.1f} yd [{result.distance_source}]")
    print(f"Pin elevation:       {v5._elevation_text(state)}")
    print(f"GSPro aim target:    {v6._state_text(v6._last_cards.get('aim'))}")
    print(f"AIM card:            {_aim_status_text()}")

    status = _last_aim_summon
    if status is not None and status.attempted:
        print(f"Aim pulse:           {status.pulse_ms:.1f} ms L + {status.pulse_ms:.1f} ms R")
        if status.left_dx_px is not None:
            print(f"Measured L move:     {status.left_dx_px:+.2f} px (response {status.response_left or 0.0:.3f})")
        print(f"Aim return:          {_return_text()}")
        print(f"Aim correction:      {_correction_text()}")
        if status.warning:
            print(f"Aim warning:         {status.warning}")

    if v6._last_cards_error is not None:
        print(f"Aim-card warning:    {v6._last_cards_error}")
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


# v5.main() resolves these globals at runtime.
v5.parse_args = parse_args_v7
v5.read_screen_state = read_screen_state_v7
v5.print_result = print_result_v7


if __name__ == "__main__":
    raise SystemExit(v5.main())
