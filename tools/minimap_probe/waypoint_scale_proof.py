#!/usr/bin/env python3
"""Deterministic proof for waypoint-first GSPro minimap scaling.

The measurements below come from the preserved Greywolf tee minimaps captured
2026-09-12 plus one preserved mid-hole fairway frame.  They intentionally keep
this proof independent of OCR / CV so it tests the scale policy itself.
"""

from __future__ import annotations

import math

from waypoint_scale import Point, WaypointObservation, resolve_minimap_scale


def between(value: float, low: float, high: float, label: str) -> None:
    if not low <= value <= high:
        raise AssertionError(f"{label}: expected {low}..{high}, got {value}")


def dual_anchor_case(
    name: str,
    ball: Point,
    pin: Point,
    pin_distance: float,
    anchors: list[tuple[float, Point]],
    expected_ypp: tuple[float, float],
) -> None:
    result = resolve_minimap_scale(
        ball=ball,
        pin=pin,
        pin_distance_yds=pin_distance,
        par=4,
        waypoints=[WaypointObservation(yards, pixel) for yards, pixel in anchors],
    )
    if result.source != "gray-waypoint":
        raise AssertionError(f"{name}: expected gray-waypoint source, got {result.source}")
    if result.waypoint_count != len(anchors):
        raise AssertionError(f"{name}: expected {len(anchors)} anchors, got {result.waypoint_count}")
    between(result.yards_per_pixel, *expected_ypp, f"{name} ypp")
    if result.waypoint_spread_pct is None or result.waypoint_spread_pct >= 1.0:
        raise AssertionError(
            f"{name}: dual-anchor spread should be <1%, got {result.waypoint_spread_pct}"
        )
    print(
        f"{name}: {result.yards_per_pixel:.4f} yd/px; "
        f"dual-anchor spread {result.waypoint_spread_pct:.2f}%; "
        f"pin diagnostic {result.diagnostic_pin_delta_pct:+.2f}%"
    )


def main() -> int:
    # Strongest evidence: two unrelated labeled GSPro gray waypoints on the same
    # minimap independently recover nearly identical local scale.
    dual_anchor_case(
        "Greywolf H3 tee",
        Point(272.9519, 849.7326),
        Point(283.25, 174.35),
        439.0,
        [
            (211.0, Point(346.2, 522.6)),
            (320.0, Point(285.0, 345.0)),
        ],
        (0.629, 0.635),
    )
    dual_anchor_case(
        "Greywolf H5 tee",
        Point(276.0055, 850.4286),
        Point(285.45, 174.35),
        524.0,
        [
            (223.0, Point(255.0, 547.8)),
            (421.0, Point(352.2, 285.0)),
        ],
        (0.734, 0.739),
    )
    dual_anchor_case(
        "Greywolf H10 tee",
        Point(281.4074, 850.5397),
        Point(279.95, 173.25),
        544.0,
        [
            (295.0, Point(327.0, 481.8)),
            (434.0, Point(283.8, 304.2)),
        ],
        (0.793, 0.796),
    )
    dual_anchor_case(
        "Greywolf H14 tee",
        Point(273.1848, 850.9783),
        Point(283.25, 174.35),
        444.0,
        [
            (209.0, Point(196.2, 531.0)),
            (341.0, Point(270.6, 313.8)),
        ],
        (0.633, 0.636),
    )

    # H1 reproduces the original ~3.7% mismatch that led to the temporary
    # 1.0375 forward calibration.  The mismatch belongs to the pin ruler, not
    # to a universal map correction.
    h1 = resolve_minimap_scale(
        ball=Point(280.8128, 851.0267),
        pin=Point(275.55, 174.35),
        pin_distance_yds=350.0,
        par=4,
        waypoints=[WaypointObservation(212.0, Point(367.8, 435.0))],
    )
    between(h1.yards_per_pixel, 0.497, 0.501, "H1 waypoint ypp")
    between(h1.diagnostic_pin_delta_pct or 0.0, 3.3, 4.1, "H1 pin bias")
    print(f"Greywolf H1 tee: pin-derived scale is {h1.diagnostic_pin_delta_pct:+.2f}% high")

    # H17 is an even stronger counterexample: straight ball->pin scaling using
    # routed hole yardage is more than six percent high.
    h17 = resolve_minimap_scale(
        ball=Point(277.7526, 850.3632),
        pin=Point(278.85, 173.25),
        pin_distance_yds=373.0,
        par=4,
        waypoints=[WaypointObservation(210.0, Point(402.6, 463.8))],
    )
    between(h17.diagnostic_pin_delta_pct or 0.0, 6.0, 7.0, "H17 pin bias")
    print(f"Greywolf H17 tee: pin-derived scale is {h17.diagnostic_pin_delta_pct:+.2f}% high")

    # Mid-hole zoom proof.  The 22-yard waypoint is deliberately ignored by the
    # resolver because near-field pixel-centering noise is too large; the 177 yd
    # gray waypoint remains a stable local ruler.
    mid = resolve_minimap_scale(
        ball=Point(279.0, 851.4),
        pin=Point(280.2, 173.4),
        pin_distance_yds=None,
        par=4,
        waypoints=[
            WaypointObservation(177.0, Point(141.0, 382.2)),
            WaypointObservation(22.0, Point(221.4, 839.4)),
        ],
    )
    between(mid.yards_per_pixel, 0.360, 0.364, "mid-hole waypoint ypp")
    if mid.waypoint_count != 1:
        raise AssertionError("Short 22-yard waypoint should be excluded from authoritative scale")
    print(f"Mid-hole fairway: {mid.yards_per_pixel:.4f} yd/px from the 177 yd waypoint")

    # User-approved par-3 exception: straight ball->pin mapping is sufficient.
    par3 = resolve_minimap_scale(
        ball=Point(280.4, 851.9444),
        pin=Point(279.95, 174.35),
        pin_distance_yds=147.0,
        par=3,
        waypoints=[],
    )
    if par3.source != "ball-pin-par3":
        raise AssertionError(f"Par 3 should use ball-pin fallback, got {par3.source}")
    between(par3.yards_per_pixel, 0.216, 0.218, "par-3 ypp")
    print(f"Greywolf H6 par 3: {par3.yards_per_pixel:.4f} yd/px from ball->pin")

    # Non-par-3 states must not silently revert to the biased pin ruler.
    try:
        resolve_minimap_scale(
            ball=Point(0.0, 700.0),
            pin=Point(0.0, 100.0),
            pin_distance_yds=400.0,
            par=4,
            waypoints=[],
        )
    except RuntimeError:
        pass
    else:
        raise AssertionError("Non-par-3 scale should fail closed without a trusted waypoint")

    print("WAYPOINT SCALE PROOF PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
