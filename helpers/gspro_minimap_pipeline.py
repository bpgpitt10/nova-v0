"""Read-only Stage C Auto Aim minimap registration and click *preflight*.

Ports the Greywolf H8/H13 proof to the packaged Windows helper without exposing
mouse commands or screen pixels to the hosted website. All captured frames stay
inside the Windows process. The native input entry point is still disabled.

The coordinates in course mode are GSPro/world YARDS from a VERIFIED shared
frame, never the unverified local hole XY used by Live Caddie rendering.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import math
import time

import cv2
import numpy as np

import auto_aim_transform as transform
import gspro_direct_click as click
import gspro_minimap_markers as markers
import gspro_window_capture as capture
import minimap_registration as registration
from waypoint_scale import Point as WaypointPoint
from waypoint_scale import WaypointObservation, resolve_minimap_scale


# These bounds match the previously tested GSPro screenshot layout.
# A left-side minimap or resized HUD needs an explicitly selected ROI and
# independent simulator validation; do not silently try random sidebars.
RIGHT_MINIMAP_ROI = (0.848, 0.520, 0.995, 0.960)
LEFT_MINIMAP_ROI = (0.005, 0.520, 0.152, 0.960)
MAX_FRAME_PIXELS = 3840 * 2160
MAX_PIN_ERROR_PX = 3.0
MAX_ACCEPTED_ERROR_YDS = 3.0


@dataclass(frozen=True)
class TeeCalibration:
    hole_key: str
    window_fingerprint: tuple[int, int, int, int, int, int]
    roi_normalized: tuple[float, float, float, float]
    canonical_pin: transform.Point
    canonical_ball: transform.Point
    yards_per_pixel: float
    scale_source: str
    course_frame_id: str | None = None
    # Stored solely in the native process; never returned by an HTTP route.
    canonical_bgr: np.ndarray = field(repr=False, compare=False, default=None)


@dataclass(frozen=True)
class AimPreview:
    hole_key: str
    shot_key: str
    mode: str
    target_canonical: transform.Point
    target_current: transform.Point
    current_ball_canonical: transform.Point
    current_pin_error_px: float
    registration_matrix: list[list[float]]
    roi_box: tuple[int, int, int, int]
    roi_normalized: tuple[float, float, float, float]
    window_fingerprint: tuple[int, int, int, int, int, int]
    click_plan: click.ClickPreflight
    yards_per_pixel: float
    # PREVIEW ONLY. A valid plan is NOT a permission to send Windows input.
    mouse_input_allowed: bool = False


@dataclass(frozen=True)
class AimVerification:
    accepted_current: transform.Point
    error_yds: float
    accepted: bool


def _validate_frame(frame_bgr: np.ndarray) -> tuple[int, int]:
    if not isinstance(frame_bgr, np.ndarray) or frame_bgr.ndim != 3 or frame_bgr.shape[2] != 3:
        raise ValueError("Expected native BGR window image")
    height, width = frame_bgr.shape[:2]
    if width < 300 or height < 200 or width * height > MAX_FRAME_PIXELS:
        raise ValueError("Native frame has invalid window dimensions")
    return width, height


def _window_fingerprint(window: dict, frame_bgr: np.ndarray) -> tuple[int, int, int, int, int, int]:
    width, height = _validate_frame(frame_bgr)
    if window.get("status") != "connected" or window.get("minimized"):
        raise ValueError("GSPro is not connected in an active window")
    pid, hwnd = window.get("pid"), window.get("hwnd")
    b = window.get("bounds") or {}
    values = (pid, hwnd, b.get("left"), b.get("top"), b.get("width"), b.get("height"))
    if not all(type(value) is int for value in values):
        raise ValueError("GSPro process or window geometry not verified")
    if pid <= 0 or hwnd <= 0 or b["width"] != width or b["height"] != height:
        raise ValueError("GSPro frame does not match discovered window")
    return values


def crop_minimap(frame_bgr: np.ndarray, roi: tuple[float, float, float, float] = RIGHT_MINIMAP_ROI):
    width, height = _validate_frame(frame_bgr)
    if len(roi) != 4 or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in roi):
        raise ValueError("Invalid normalized minimap region")
    x1, y1, x2, y2 = roi
    if not (0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1):
        raise ValueError("Minimap region outside native window")
    x0, y0 = int(width * x1), int(height * y1)
    x_end, y_end = int(width * x2), int(height * y2)
    rw, rh = x_end - x0, y_end - y0
    if rw < 60 or rh < 90:
        raise ValueError("Minimap crop is too small for registration")
    return frame_bgr[y0:y_end, x0:x_end].copy(), (x0, y0, rw, rh)


def capture_native_bgr(window: dict) -> np.ndarray:
    """Optional on-demand in-process capture, never called by HTTP routes.

    PrintWindow may be blank or stale for Unity; only real PC validation can
    establish capture parity. A quality pass is NOT a freshness guarantee.
    """
    report = capture.probe_gspro_capture(window, keep_pixels=True)
    if report.get("status") != "captured":
        raise RuntimeError("Native capture unavailable: " + str(report.get("reason") or report.get("status")))
    raw = report.pop("_private_bgra")
    height, width = report["windowHeight"], report["windowWidth"]
    array = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)
    return cv2.cvtColor(array, cv2.COLOR_BGRA2BGR).copy()


def calibrate_tee(
    frame_bgr: np.ndarray,
    *,
    window: dict,
    hole_key: str,
    par: int,
    pin_distance_yds: float | None,
    waypoint_observations: tuple[WaypointObservation, ...] = (),
    roi: tuple[float, float, float, float] = RIGHT_MINIMAP_ROI,
    course_frame_id: str | None = None,
) -> TeeCalibration:
    """Cache canonical tee frame only after authoritative waypoint/par3 scale.

    Non-par-3 requires pre-verified gray waypoint labels. The old CV+Tesseract
    waypoint detector is included in the build, but not automatically invoked:
    the companion's Windows OCR parity still needs a real GSPro validation.
    """
    if not isinstance(hole_key, str) or not hole_key.strip() or len(hole_key) > 160:
        raise ValueError("Missing stable hole identity")
    if par not in (3, 4, 5):
        raise ValueError("Par must be 3, 4 or 5")
    fingerprint = _window_fingerprint(window, frame_bgr)
    canonical, _box = crop_minimap(frame_bgr, roi)
    ball = markers.detect_actual_ball_marker(canonical)
    pin = markers.detect_pin_marker(canonical)
    scale = resolve_minimap_scale(
        ball=WaypointPoint(ball.x, ball.y),
        pin=WaypointPoint(pin.x, pin.y),
        pin_distance_yds=pin_distance_yds,
        par=par,
        waypoints=waypoint_observations,
    )
    if not math.isfinite(scale.yards_per_pixel) or scale.yards_per_pixel <= 0:
        raise ValueError("Invalid canonical tee scale")
    return TeeCalibration(
        hole_key=hole_key, window_fingerprint=fingerprint,
        roi_normalized=roi, canonical_ball=ball, canonical_pin=pin,
        yards_per_pixel=scale.yards_per_pixel, scale_source=scale.source,
        course_frame_id=course_frame_id, canonical_bgr=canonical.copy(),
    )


def preview_aim(
    calibration: TeeCalibration,
    current_frame_bgr: np.ndarray,
    *,
    window: dict,
    hole_key: str,
    shot_key: str,
    explicitly_armed: bool,
    captured_at_monotonic: float,
    now_monotonic: float | None = None,
    forward_yds: float | None = None,
    right_yds: float | None = None,
    tee_course: transform.Point | None = None,
    pin_course: transform.Point | None = None,
    target_course: transform.Point | None = None,
    course_frame_id: str | None = None,
) -> AimPreview:
    """Produce verified target pixels, never move the mouse.

    Exactly one target mode must be selected. Native code must provide capture
    timestamp and shot identity; do not trust such values from a browser POST.
    """
    fingerprint = _window_fingerprint(window, current_frame_bgr)
    if fingerprint != calibration.window_fingerprint or hole_key != calibration.hole_key:
        raise ValueError("GSPro window or hole changed since tee calibration")
    if not isinstance(shot_key, str) or not shot_key.strip() or len(shot_key) > 160:
        raise ValueError("Missing stable current shot identity")
    if not explicitly_armed:
        raise ValueError("User must explicitly arm each recommended aim")
    now = time.monotonic() if now_monotonic is None else now_monotonic
    age_ms = 1000 * (now - captured_at_monotonic)
    if not math.isfinite(age_ms) or not 0 <= age_ms <= click.MAX_CAPTURE_AGE_MS:
        raise ValueError("GSPro image capture is stale")
    is_offset = forward_yds is not None or right_yds is not None
    is_course = any(value is not None for value in (tee_course, pin_course, target_course))
    if is_offset == is_course:
        raise ValueError("Supply exactly one verified aim coordinate mode")

    current, roi_box = crop_minimap(current_frame_bgr, calibration.roi_normalized)
    ball = markers.detect_actual_ball_marker(current)
    pin = markers.detect_pin_marker(current)
    solved, pin_error = registration.register_current_to_canonical_verified(
        current, calibration.canonical_bgr,
        current_pin_xy=(pin.x, pin.y),
        canonical_pin_xy=(calibration.canonical_pin.x, calibration.canonical_pin.y),
        max_pin_error_px=MAX_PIN_ERROR_PX,
    )
    ball_can = transform.current_to_canonical(solved.matrix_2x3, ball)
    if is_offset:
        if forward_yds is None or right_yds is None:
            raise ValueError("Forward/right offset coordinates must be paired")
        if not all(math.isfinite(value) for value in (forward_yds, right_yds)):
            raise ValueError("Non-finite target offset")
        target_can = transform.canonical_offset_target(
            current_ball_canonical=ball_can,
            canonical_tee=calibration.canonical_ball,
            canonical_pin=calibration.canonical_pin,
            canonical_yards_per_pixel=calibration.yards_per_pixel,
            forward_yds=forward_yds,
            right_yds=right_yds,
        )
        mode = "current-offset"
    else:
        if tee_course is None or pin_course is None or target_course is None:
            raise ValueError("Course coordinates must include tee, pin and target")
        if not course_frame_id or course_frame_id != calibration.course_frame_id:
            raise ValueError("Unverified GSPro-to-Looper course coordinate frame")
        target_can = transform.course_point_to_canonical_pixel(
            tee_course=tee_course, pin_course=pin_course, target_course=target_course,
            canonical_tee=calibration.canonical_ball,
            canonical_pin=calibration.canonical_pin,
            canonical_yards_per_pixel=calibration.yards_per_pixel,
        )
        mode = "verified-course-point"
    target_cur = transform.canonical_to_current(solved.matrix_2x3, target_can)
    plan = click.prepare_verified_minimap_click(
        window=window, minimap_roi=roi_box,
        target_roi_px=(target_cur.x, target_cur.y),
        snapshot_age_ms=age_ms, pin_registration_error_px=pin_error,
        shot_key=shot_key, ui_confirmed=explicitly_armed,
    )
    return AimPreview(
        hole_key=hole_key, shot_key=shot_key, mode=mode,
        target_canonical=target_can, target_current=target_cur,
        current_ball_canonical=ball_can, current_pin_error_px=pin_error,
        registration_matrix=solved.matrix_2x3,
        roi_box=roi_box, roi_normalized=calibration.roi_normalized,
        window_fingerprint=fingerprint,
        click_plan=plan, yards_per_pixel=calibration.yards_per_pixel,
    )


def verify_accepted_marker(
    preview: AimPreview,
    after_frame_bgr: np.ndarray,
    *,
    window: dict,
    hole_key: str,
    shot_key: str,
) -> AimVerification:
    """Offline proof math for GSPro's magenta marker after a future *real* click.

    Caller must establish that a click actually occurred, compare fresh pre/post
    frames, and revalidate current shot identity; this function is not a command
    and alone cannot establish that GSPro accepted a new aim.
    """
    if hole_key != preview.hole_key or shot_key != preview.shot_key:
        raise ValueError("Shot or hole changed before aim verification")
    if _window_fingerprint(window, after_frame_bgr) != preview.window_fingerprint:
        raise ValueError("GSPro window changed before aim verification")
    current, box = crop_minimap(after_frame_bgr, preview.roi_normalized)
    if box != preview.roi_box:
        raise ValueError("Minimap ROI changed before aim verification")
    observed = markers.detect_magenta_aim_marker(current, expected=preview.target_current)
    actual_can = transform.current_to_canonical(preview.registration_matrix, observed)
    error = transform.canonical_error_yards(
        actual_can, preview.target_canonical, preview.yards_per_pixel,
    )
    return AimVerification(
        accepted_current=observed, error_yds=error,
        accepted=error <= MAX_ACCEPTED_ERROR_YDS,
    )
