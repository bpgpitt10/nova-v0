"""Read-only integration of previously proven GSPro minimap waypoint calibration.

No new shot-state engine, no mouse input, no screenshots or paths in HTTP JSON.
A calibration is diagnostic/provisional until independently matched to the
authoritative Live Caddie state and the current on-screen GSPro hole.
"""
from __future__ import annotations

import math
import threading
import time

import cv2
import numpy as np

import gspro_minimap_pipeline as pipeline
import gspro_native_wind_ocr as wind_ocr
import minimap_registration as registration
import waypoint_scale_cv as waypoint_cv
from waypoint_scale import Point, WaypointObservation, resolve_minimap_scale

MAX_WAYPOINT_CANDIDATES = 4
MIN_WAYPOINT_VOTES = 4  # A single OCR reading cannot seed a tee-scale cache.
WAYPOINT_OCR_BUDGET_SECONDS = 17.0
MAX_TEE_RECORD_AGE_MS = 5 * 60 * 1000
MAX_TEE_CACHE_AGE_SECONDS = 75 * 60
MAX_REGISTER_PIN_ERROR_PX = 3.0
_tee_lock = threading.Lock()
_tee_cache = None


def _point(value):
    return {"x": round(float(value.x), 2), "y": round(float(value.y), 2)}


def _identity(state):
    """Diagnostic identity only; completed record might be from a prior hole."""
    shot = state.get("shot") or {}
    if shot.get("kind") not in ("pre_shot", "last_completed"):
        return None
    course = shot.get("courseKey")
    number = shot.get("holeNumber")
    round_id = shot.get("roundId")
    if (not isinstance(course, str) or not course or len(course) > 130
            or not isinstance(number, int) or number not in range(1, 19)
            or not isinstance(round_id, (int, str))):
        return None
    return (course, str(round_id), number)


def _is_fresh_tee(state, cropped, ball):
    shot = state.get("shot") or {}
    age = state.get("fileAgeMs")
    # CurrentShot pre-shot is the only native record allowed to seed a tee
    # diagnostic. The last-completed file must NOT seed a new tee anchor.
    return (shot.get("status") == "ready" and shot.get("kind") == "pre_shot"
            and shot.get("shotNumber") == 1
            and isinstance(age, (int, float)) and 0 <= age <= MAX_TEE_RECORD_AGE_MS
            and ball.y >= cropped.shape[0] * 0.72)


def _current_cache(key, fingerprint):
    global _tee_cache
    with _tee_lock:
        item = _tee_cache
        if item is None:
            return None
        if (time.monotonic() - item["createdAt"] > MAX_TEE_CACHE_AGE_SECONDS
                or item["key"] != key or item["fingerprint"] != fingerprint):
            _tee_cache = None
            return None
        return item


def _store_tee(key, fingerprint, calibration):
    global _tee_cache
    with _tee_lock:
        _tee_cache = {
            "key": key, "fingerprint": fingerprint,
            "createdAt": time.monotonic(), "calibration": calibration,
        }


def _par3_direct_reference(state, ball, pin):
    """Use verified fresh tee -> pin *horizontal* world distance only on par 3.

    The GSPro hole-layout array is not authoritative by itself; require a
    matching hole and physical starting position close to its tee before
    offering even a provisional direct-distance ruler.
    """
    layout = state.get("layout") or {}
    shot = state.get("shot") or {}
    if (layout.get("status") != "ready" or layout.get("par") != 3
            or layout.get("holeNumber") != shot.get("holeNumber")):
        return None
    tee, target, origin = layout.get("teeWorld"), layout.get("pinWorld"), shot.get("startingWorld")
    if not all(isinstance(point, dict) for point in (tee, target, origin)):
        return None
    try:
        def horiz(a, b):
            return math.hypot(
                float(a["x"]) - float(b["x"]),
                float(a["z"]) - float(b["z"]),
            ) * 1.0936132983377078
        if horiz(tee, origin) > 20.0:
            return None
        distance = horiz(origin, target)
        resolution = resolve_minimap_scale(
            ball=Point(ball.x, ball.y), pin=Point(pin.x, pin.y),
            pin_distance_yds=distance, par=3,
        )
        return resolution
    except (RuntimeError, ValueError, KeyError, TypeError, OverflowError):
        return None


def _cache_tee_calibration(identity, fingerprint, cropped, ball, pin, roi,
                           ypp, source):
    from auto_aim_transform import Point as PixelPoint
    calibration = pipeline.TeeCalibration(
        hole_key=":".join(map(str, identity)),
        window_fingerprint=fingerprint,
        roi_normalized=roi,
        canonical_pin=PixelPoint(pin.x, pin.y),
        canonical_ball=PixelPoint(ball.x, ball.y),
        yards_per_pixel=ypp,
        scale_source=source,
        canonical_bgr=cropped.copy(),
    )
    _store_tee(identity, fingerprint, calibration)


def _register(cropped, pin, cache):
    calibration = cache["calibration"]
    fitted, pin_error = registration.register_current_to_canonical_verified(
        cropped, calibration.canonical_bgr,
        current_pin_xy=(pin.x, pin.y),
        canonical_pin_xy=(calibration.canonical_pin.x, calibration.canonical_pin.y),
        max_pin_error_px=MAX_REGISTER_PIN_ERROR_PX,
    )
    # Similarity transform maps current pixels into canonical pixels.
    return {
        "status": "registered_candidate_unverified",
        "reason": "Validated against cached native tee pin; Live Caddie current-hole binding still required before aim.",
        "source": "cached-tee-feature-registration",
        "teeScaleYardsPerPixel": round(calibration.yards_per_pixel, 6),
        "currentScaleYardsPerPixel": round(calibration.yards_per_pixel * fitted.scale, 6),
        "zoomRatioCurrentToTee": round(fitted.scale, 5),
        "rotationDegrees": round(fitted.rotation_deg, 3),
        "pinErrorPixels": round(pin_error, 3),
        "inliers": fitted.inliers,
        "inlierRatio": round(fitted.inlier_ratio, 4),
        "medianReprojectionErrorPixels": round(fitted.median_reprojection_error_px, 3),
        "confidence": round(fitted.confidence, 4),
    }


def observe(cropped, ball, pin, *, window, frame_bgr, roi, state):
    """Return **only JSON-safe numeric observations**; cache imagery privately.

    It can calculate a dogleg-safe LOCAL yard ruler without a course-layout
    record. The result is NEVER a permission to click or assume OSM XY matches
    GSPro/world XY. A tee cache is only seeded by fresh pre-shot evidence.
    """
    result = {
        "waypointRuler": {
            "status": "unavailable", "reason": "no_labeled_gray_waypoint",
            "candidates": [],
        },
        "registration": {
            "status": "unavailable", "reason": "no_validated_tee_anchor",
        },
        "scale": {
            "status": "unavailable", "reason": "no_labeled_gray_waypoint",
        },
    }
    bundle = wind_ocr._tesseract_bundle()
    if bundle is None:
        result["waypointRuler"]["reason"] = "bundled_tesseract_unavailable"
        result["scale"]["reason"] = "bundled_tesseract_unavailable"
        return result

    # Proven registration requires a stable GSPro window/HWND/DPI fingerprint.
    try:
        fingerprint = pipeline._window_fingerprint(window, frame_bgr)
    except (ValueError, TypeError) as exc:
        fingerprint = None
        result["registration"]["reason"] = "window_fingerprint_unverified:" + str(exc)[:90]
    identity = _identity(state)
    cached = _current_cache(identity, fingerprint) if identity and fingerprint else None
    fresh_tee = bool(identity and fingerprint and _is_fresh_tee(state, cropped, ball))
    if fresh_tee:
        par3 = _par3_direct_reference(state, ball, pin)
        if par3 is not None:
            result["scale"] = {
                "status": "provisional_par3",
                "source": "ball-pin-par3",
                "yardsPerPixel": round(par3.yards_per_pixel, 6),
                "reason": "Fresh direct GSPro par-3 tee-to-pin ruler; Live Caddie authoritative course binding still required.",
            }
            result["waypointRuler"]["reason"] = "par3_direct_ruler_no_waypoint_needed"
            _cache_tee_calibration(
                identity, fingerprint, cropped, ball, pin, roi,
                par3.yards_per_pixel, "ball-pin-par3",
            )
            result["registration"] = {
                "status": "tee_anchor_candidate_cached",
                "source": "ball-pin-par3",
                "reason": "Direct par-3 ruler; course/shot identity still diagnostic-only.",
            }
            return result

    # On post-tee frames, prefer historical tee-image registration. GSPro
    # waypoint labels can disappear/change on zoom; don't recalibrate there.
    if cached and not fresh_tee:
        try:
            result["registration"] = _register(cropped, pin, cached)
            result["scale"] = {
                "status": "provisional_registered_tee",
                "source": "cached-tee-feature-registration",
                "yardsPerPixel": result["registration"]["currentScaleYardsPerPixel"],
                "reason": "Registration is read-only; current Live Caddie hole/shot binding not proven.",
            }
        except (RuntimeError, ValueError, cv2.error) as exc:
            result["registration"]["reason"] = "registration_rejected:" + str(exc)[:145]
        result["waypointRuler"]["reason"] = "post_tee_uses_cached_tee_ruler"
        return result

    try:
        detected = waypoint_cv.detect_gray_waypoints(
            cropped,
            tesseract_path=str(bundle[0]),
            max_candidates=MAX_WAYPOINT_CANDIDATES,
            time_budget_s=WAYPOINT_OCR_BUDGET_SECONDS,
        )
    except (RuntimeError, ValueError, cv2.error, OSError) as exc:
        result["waypointRuler"]["reason"] = "waypoint_ocr_error:" + type(exc).__name__
        return result

    result["waypointRuler"]["candidates"] = [
        {
            "pixel": _point(item.pixel), "yards": item.yards,
            "confidence": round(item.confidence, 3),
            "ocrVotes": item.ocr_votes,
        } for item in detected[:MAX_WAYPOINT_CANDIDATES]
    ]
    if not detected:
        return result
    verified_votes = [item for item in detected if item.ocr_votes >= MIN_WAYPOINT_VOTES]
    if not verified_votes:
        result["waypointRuler"]["status"] = "detected_unverified"
        result["waypointRuler"]["reason"] = "waypoint_labels_below_four_ocr_votes"
        result["scale"]["reason"] = "low_waypoint_ocr_confidence"
        return result
    try:
        resolution = resolve_minimap_scale(
            ball=Point(ball.x, ball.y),
            pin=Point(pin.x, pin.y),
            pin_distance_yds=None,
            par=None,  # NEVER use dogleg routed hole yardage as a pin ruler.
            waypoints=[
                WaypointObservation(
                    yards=item.yards, pixel=item.pixel, confidence=item.confidence
                ) for item in verified_votes
            ],
        )
    except (RuntimeError, ValueError) as exc:
        result["waypointRuler"]["status"] = "detected_unverified"
        result["waypointRuler"]["reason"] = str(exc)[:145]
        result["scale"]["reason"] = "waypoint_scale_rejected"
        return result

    result["waypointRuler"].update({
        "status": "scale_candidate",
        "reason": "Direct GSPro ball-to-gray-waypoint distance; independent current-hole check pending.",
        "waypointCount": resolution.waypoint_count,
        "spreadPercent": resolution.waypoint_spread_pct,
    })
    result["scale"] = {
        "status": "provisional_gray_waypoint",
        "source": resolution.source,
        "yardsPerPixel": round(resolution.yards_per_pixel, 6),
        "waypointCount": resolution.waypoint_count,
        "waypointSpreadPct": resolution.waypoint_spread_pct,
        "reason": "Dogleg-safe minimap ruler; not yet a current-hole/OSM registered aim scale.",
    }
    if fresh_tee:
        # Same proven native tee cache, independent of par/route geometry.
        _cache_tee_calibration(
            identity, fingerprint, cropped, ball, pin, roi,
            resolution.yards_per_pixel, "gray-waypoint",
        )
        result["registration"] = {
            "status": "tee_anchor_candidate_cached",
            "reason": "Fresh native pre-shot H/round evidence; browser authoritative state confirmation still pending.",
            "source": "gray-waypoint",
        }
    elif not identity:
        result["registration"]["reason"] = "no_fresh_round_hole_identity"
    elif not fresh_tee:
        result["registration"]["reason"] = "no_fresh_tee_preshot_evidence"
    return result
