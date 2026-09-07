#!/usr/bin/env python3
"""Explicitly gated GSPro application of a Looper full-shot recommendation.

This is intentionally NOT called by post-tee v4.  v4 remains read-only.  A future
v5/live runtime may call this module only when automatic aim is explicitly enabled.

Safety sequence when enabled:
1. perform a same-shot neutral LEFT/RIGHT calibration pair;
2. derive yards/ms from canonical AIM-marker geometry, not 3D camera pixels;
3. require the neutral return to verify within configured tolerance;
4. ask the pure aim planner for a bounded LEFT/RIGHT duration;
5. apply one command;
6. re-read the fresh AIM card and marker after movement;
7. verify achieved cross-track offset; never silently assume success.

No putting logic is involved.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from types import SimpleNamespace
import sys
import time

import aim_actuator
import posttee_geometry
import probe as base
import probe_v8
import target_card_v8  # noqa: F401

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.live_caddie.aim_geometry import (  # noqa: E402
    AimContext2D,
    calibration_from_contexts,
    verify_requested_offset,
)
from tools.live_caddie.aim_planning import build_aim_plan  # noqa: E402
from tools.live_caddie.assumptions import Assumptions  # noqa: E402
from tools.live_caddie.models import RecommendationResult  # noqa: E402


@dataclass
class RecommendationAimApplyResult:
    status: str
    plan: dict
    calibration: dict | None
    neutral_return: dict | None
    verification: dict | None
    final_aim: dict | None
    final_geometry: dict | None
    warning: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _context(geometry: dict) -> AimContext2D:
    aim = geometry.get("aim_context") or {}
    if aim.get("forward_yds") is None or aim.get("right_yds") is None:
        raise RuntimeError("canonical AIM context unavailable")
    return AimContext2D(float(aim["forward_yds"]), float(aim["right_yds"]))


def _read_aim(screen, tesseract_path: str | None):
    args = SimpleNamespace(tesseract=tesseract_path)
    return probe_v8._read_card_type(screen, "aim", args, None, True)


def _analyze_screen(
    *,
    screen,
    roi: str | None,
    pin_distance_yds: float,
    aim_distance_yds: float,
    output_root: str | Path,
    round_identity: dict | None,
):
    minimap, _ = base.crop_minimap(screen, roi)
    return posttee_geometry.analyze(
        current_minimap=minimap,
        pin_distance_yds=float(pin_distance_yds),
        aim_distance_yds=float(aim_distance_yds),
        output_root=output_root,
        round_identity=round_identity,
    )


def _pulse_and_capture(*, key: str, duration_ms: float, settle_ms: float, monitor: int):
    found = aim_actuator.find_gspro_window()
    if found is None:
        raise RuntimeError("Could not find visible GSPro window for recommendation AIM")
    hwnd, _title = found
    if not aim_actuator.focus_gspro(hwnd, wait_s=0.02):
        raise RuntimeError("Could not safely focus GSPro for recommendation AIM")
    aim_actuator.pulse_key_windows(key, float(duration_ms))
    time.sleep(max(0.0, float(settle_ms)) / 1000.0)
    return base.capture_monitor(monitor)


def calibrate_and_apply(
    *,
    recommendation: RecommendationResult,
    baseline_geometry: dict,
    pin_distance_yds: float,
    round_identity: dict | None,
    output_root: str | Path,
    monitor: int,
    roi: str | None = None,
    tesseract_path: str | None = None,
    automatic_enabled: bool = False,
    assumptions: Assumptions | None = None,
) -> RecommendationAimApplyResult:
    assumptions = assumptions or Assumptions.load()
    config = assumptions.get("actuation")

    # Absolutely no GSPro input occurs unless this call is explicitly enabled.
    if not automatic_enabled:
        plan = build_aim_plan(
            recommendation,
            calibration=None,
            assumptions=assumptions,
            automatic_enabled=False,
        )
        return RecommendationAimApplyResult(
            status="blocked",
            plan=plan.to_dict(),
            calibration=None,
            neutral_return=None,
            verification=None,
            final_aim=None,
            final_geometry=None,
            warning="automatic recommendation AIM was not explicitly enabled",
        )

    baseline = _context(baseline_geometry)
    sample_ms = float(config["aim_pulse_ms"])
    settle_ms = float(config["aim_settle_ms"])
    tolerance = float(config["verification_tolerance_yds"])

    # Controlled sample left.
    after_left = _pulse_and_capture(
        key="LEFT", duration_ms=sample_ms, settle_ms=settle_ms, monitor=monitor
    )
    left_aim = _read_aim(after_left, tesseract_path)
    left_geometry = _analyze_screen(
        screen=after_left,
        roi=roi,
        pin_distance_yds=pin_distance_yds,
        aim_distance_yds=float(left_aim.distance_yds),
        output_root=output_root,
        round_identity=round_identity,
    )

    # Matched return right.  If anything after the left pulse fails, caller should
    # treat the run as unsafe/failed and require human review rather than guessing.
    returned = _pulse_and_capture(
        key="RIGHT", duration_ms=sample_ms, settle_ms=settle_ms, monitor=monitor
    )
    returned_aim = _read_aim(returned, tesseract_path)
    returned_geometry = _analyze_screen(
        screen=returned,
        roi=roi,
        pin_distance_yds=pin_distance_yds,
        aim_distance_yds=float(returned_aim.distance_yds),
        output_root=output_root,
        round_identity=round_identity,
    )

    neutral_verify = verify_requested_offset(
        baseline=baseline,
        achieved=_context(returned_geometry),
        requested_offset_yds=0.0,
        tolerance_yds=tolerance,
    )
    if not neutral_verify.verified:
        blocked = build_aim_plan(
            recommendation,
            calibration=None,
            assumptions=assumptions,
            automatic_enabled=False,
        )
        return RecommendationAimApplyResult(
            status="blocked",
            plan=blocked.to_dict(),
            calibration=None,
            neutral_return=neutral_verify.to_dict(),
            verification=None,
            final_aim=probe_v8._state_dict(returned_aim),
            final_geometry=returned_geometry,
            warning="same-shot neutral AIM calibration did not return within configured tolerance",
        )

    registration_confidence = min(
        float((baseline_geometry.get("registration") or {}).get("confidence") or 0.0),
        float((left_geometry.get("registration") or {}).get("confidence") or 0.0),
        float((returned_geometry.get("registration") or {}).get("confidence") or 0.0),
    )
    calibration = calibration_from_contexts(
        baseline=baseline,
        sampled=_context(left_geometry),
        pulse_ms=sample_ms,
        confidence=registration_confidence,
    )
    plan = build_aim_plan(
        recommendation,
        calibration=calibration,
        assumptions=assumptions,
        automatic_enabled=True,
    )
    if plan.status != "ready":
        return RecommendationAimApplyResult(
            status="blocked",
            plan=plan.to_dict(),
            calibration={
                "sample_pulse_ms": calibration.sample_pulse_ms,
                "observed_cross_track_yds": calibration.observed_cross_track_yds,
                "yards_per_ms": calibration.yards_per_ms,
                "confidence": calibration.confidence,
            },
            neutral_return=neutral_verify.to_dict(),
            verification=None,
            final_aim=probe_v8._state_dict(returned_aim),
            final_geometry=returned_geometry,
            warning=plan.reason,
        )

    moved = _pulse_and_capture(
        key=str(plan.direction),
        duration_ms=float(plan.pulse_duration_ms),
        settle_ms=settle_ms,
        monitor=monitor,
    )
    moved_aim = _read_aim(moved, tesseract_path)
    moved_geometry = _analyze_screen(
        screen=moved,
        roi=roi,
        pin_distance_yds=pin_distance_yds,
        aim_distance_yds=float(moved_aim.distance_yds),
        output_root=output_root,
        round_identity=round_identity,
    )
    verification = verify_requested_offset(
        baseline=_context(returned_geometry),
        achieved=_context(moved_geometry),
        requested_offset_yds=float(plan.requested_offset_yds),
        tolerance_yds=tolerance,
    )

    return RecommendationAimApplyResult(
        status="applied-verified" if verification.verified else "applied-unverified",
        plan=plan.to_dict(),
        calibration={
            "sample_pulse_ms": calibration.sample_pulse_ms,
            "observed_cross_track_yds": calibration.observed_cross_track_yds,
            "yards_per_ms": calibration.yards_per_ms,
            "confidence": calibration.confidence,
        },
        neutral_return=neutral_verify.to_dict(),
        verification=verification.to_dict(),
        final_aim=probe_v8._state_dict(moved_aim),
        final_geometry=moved_geometry,
        warning=None if verification.verified else "GSPro AIM move did not verify within configured tolerance; no automatic correction was attempted",
    )
