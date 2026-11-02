"""Bounded, read-only GSPro live observation probe for the Windows companion.

Single native snapshot: exact structured GSPro shot/tee/pin world observations,
legacy Windows wind + lie HUD OCR, minimap ball/pin pixels and honest scale.
No screenshot transmission, GSPro modification, desktop input or fake tee mapping.
"""
from __future__ import annotations
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import time

import cv2
import numpy as np
import gspro_minimap_pipeline as pipeline
import gspro_minimap_markers as markers
import gspro_native_discovery as native
import gspro_window_capture as capture
import gspro_native_wind_ocr as wind_ocr
import gspro_native_lie_ocr as lie_ocr
import gspro_native_hud_ocr as hud_ocr
import gspro_companion_minimap_calibration as waypoint_diagnostics
from waypoint_scale import Point, resolve_minimap_scale

METERS_TO_YARDS = 1.0936132983377078
MAX_CURRENT_BYTES = 4 * 1024 * 1024
MAX_LOG_BYTES = 5 * 1024 * 1024
MAX_STALE_MS = 5 * 60 * 1000
MAX_LAYOUT_ERROR_YDS = 20.0
MIN_PIXELS_FOR_SCALE = 24.0


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _num(value):
    try:
        if value is None or isinstance(value, bool):
            return None
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def _point(value):
    if not isinstance(value, dict):
        return None
    xyz = [_num(value.get(k)) for k in ("x", "y", "z")]
    return {"x": xyz[0], "y": xyz[1], "z": xyz[2]} if all(v is not None for v in xyz) else None


def _distance(a, b, horizontal=False):
    if not a or not b:
        return None
    dx = a["x"] - b["x"]
    dz = a["z"] - b["z"]
    dy = 0 if horizontal else a["y"] - b["y"]
    return round(math.sqrt(dx * dx + dz * dz + dy * dy) * METERS_TO_YARDS, 2)


def _bounded_text(path, maximum):
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            if size > maximum:
                f.seek(size - maximum)
            raw = f.read(maximum)
        return raw.decode("utf-8-sig", errors="replace"), round((time.time() - path.stat().st_mtime) * 1000), size > maximum
    except (OSError, PermissionError):
        return None, None, False


def _records(source):
    if isinstance(source, list):
        return [x for x in source if isinstance(x, dict)]
    if not isinstance(source, dict):
        return []
    records = []
    for value in source.values():
        if isinstance(value, list):
            records += [x for x in value if isinstance(x, dict)]
    return records


def _shot_number(x):
    return _num(x.get("GlobalShotNumber")) or _num(x.get("HoleShot")) or -1


def parse_current_round(raw):
    """CurrentShot.StartingPOS is prioritized; an old completed shot is labelled old."""
    if not raw:
        return {"status": "unavailable", "reason": "current_round_missing"}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return {"status": "unavailable", "reason": "current_round_invalid_json"}
    active = (parsed.get("CurrentShot") or parsed.get("currentShot")) if isinstance(parsed, dict) else None
    if not isinstance(active, dict):
        active = None
    records = _records(parsed)
    completed = sorted(records, key=_shot_number)[-1] if records else None
    item = active or completed
    if not item:
        return {"status": "unavailable", "reason": "current_round_no_shot"}
    hole = _num(item.get("Hole"))
    hole_number = int(round(hole)) + 1 if hole is not None else None
    if hole_number is not None and not 1 <= hole_number <= 18:
        hole_number = None
    shot = _num(item.get("HoleShot"))
    return {
        "status": "ready" if active else "completed_record_only",
        "kind": "pre_shot" if active else "last_completed",
        "holeNumber": hole_number,
        "shotNumber": int(shot) if shot is not None else None,
        "roundId": item.get("RoundID") if isinstance(item.get("RoundID"), (int, str)) else None,
        "shotId": str(item.get("ShotID"))[:90] if item.get("ShotID") is not None else None,
        "courseKey": str(item.get("CourseKey"))[:130] if item.get("CourseKey") is not None else None,
        "startingWorld": _point(item.get("StartingPOS")),
        "endingWorld": _point(item.get("EndingPOS")),
        "distanceToPinYds": round(_num(item.get("DistanceToPin")) * METERS_TO_YARDS, 2)
            if _num(item.get("DistanceToPin")) is not None else None,
        "startingSurfaceRaw": _num(item.get("StartingSurface")),
        # Raw numeric identifiers are EVIDENCE, not validated surface labels.
        # Capture BOTH sides so a verified next-shot HUD label can eventually
        # be paired with this physical shot's ending code.
        "endingSurfaceRaw": _num(item.get("EndingSurface")),
    }


def parse_course_layout(log_text, hole_number):
    if not log_text or not hole_number:
        return {"status": "unavailable", "reason": "no_log_or_hole"}
    decoder = json.JSONDecoder()
    latest = None
    for match in re.finditer(r'\[\s*\{\s*"active"', log_text):
        try:
            value, _ = decoder.raw_decode(log_text[match.start():])
            if isinstance(value, list) and len(value) >= 9:
                latest = value
        except (ValueError, TypeError):
            pass
    if not latest or hole_number > len(latest):
        return {"status": "unavailable", "reason": "course_layout_not_found"}
    row = latest[hole_number - 1]
    if not isinstance(row, dict):
        return {"status": "unavailable", "reason": "layout_row_invalid"}
    tee = _point(row.get("teePos"))
    pin = _point(row.get("pinPos"))
    if not tee or not pin:
        return {"status": "unavailable", "reason": "layout_missing_tee_or_pin"}
    return {
        "status": "ready",
        "binding": "hole_array_order_unverified",
        "holeNumber": hole_number,
        "par": int(row["par"]) if _num(row.get("par")) in (3, 4, 5) else None,
        "teeWorld": tee,
        "pinWorld": pin,
        "teeToPinWorldYards": _distance(tee, pin),
        "teeToPinHorizontalYards": _distance(tee, pin, True),
    }


def read_structured_state(discovery):
    data = discovery.get("directory")
    if data is None:
        return {"status": "unavailable", "reason": "gspro_folder_missing",
                "shot": {"status": "unavailable"}, "layout": {"status": "unavailable"}}
    root = Path(data)
    round_raw, age, truncated = _bounded_text(root / "currentRound.dat", MAX_CURRENT_BYTES)
    shot = parse_current_round(round_raw if not truncated else None)
    if truncated:
        shot = {"status": "unavailable", "reason": "current_round_exceeds_limit"}
    log_raw, log_age, log_truncated = _bounded_text(root / "output_log.txt", MAX_LOG_BYTES)
    layout = parse_course_layout(log_raw, shot.get("holeNumber"))
    if log_truncated and layout["status"] != "ready":
        layout["reason"] = "layout_not_in_last_5mb_log"
    if age is not None and age > MAX_STALE_MS:
        shot["status"] = "stale"
    return {
        "status": "ready" if shot["status"] == "ready" else "partial",
        "shot": shot, "layout": layout,
        "fileAgeMs": age,
        "logAgeMs": log_age,
        "note": "Coordinates are GSPro-world X/Y/Z, not OSM geolocation or validated Looper map positions.",
    }


def _image_observation(window, state, *, report=None, include_waypoints=True):
    report = report if report is not None else capture.probe_gspro_capture(window, keep_pixels=True)
    result = {
        "status": report.get("status", "unavailable"),
        "method": report.get("method"),
        "quality": report.get("quality"),
        "reason": report.get("reason"),
        "ballPixel": None,
        "pinPixel": None,
        "minimapSide": None,
        "scale": {"status": "unavailable", "reason": "pixel_markers_not_verified"},
        "freshness": "single_capture_unverified",
    }
    raw = report.get("_private_bgra")
    if report.get("status") != "captured" or raw is None:
        return result
    width, height = report["windowWidth"], report["windowHeight"]
    frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)[:, :, :3].copy()
    errors = []
    for side, roi in (("right", pipeline.RIGHT_MINIMAP_ROI), ("left", pipeline.LEFT_MINIMAP_ROI)):
        try:
            markers_started = time.perf_counter()
            cropped, box = pipeline.crop_minimap(frame, roi)
            ball = markers.detect_actual_ball_marker(cropped)
            pin = markers.detect_pin_marker(cropped)
            result["timingMs"] = {"markerDetection": round(
                (time.perf_counter() - markers_started) * 1000, 2
            )}
            gap = math.hypot(pin.x - ball.x, pin.y - ball.y)
            if gap < MIN_PIXELS_FOR_SCALE:
                raise ValueError("ball_pin_too_close_for_scale")
            result["status"] = "markers_found"
            result["minimapSide"] = side
            result["ballPixel"] = {"x": round(ball.x, 2), "y": round(ball.y, 2)}
            result["pinPixel"] = {"x": round(pin.x, 2), "y": round(pin.y, 2)}
            result["minimapRoiWindowPixels"] = list(box)
            result["ballToPinPixels"] = round(gap, 2)
            if not include_waypoints:
                # Waypoint OCR (~3.4 s) only measures a tee Looper can't place;
                # the page asks for it only then.
                result["scale"] = {"status": "unavailable", "reason": "waypoints_not_requested"}
                return result
            # Reuse the already-proven gray waypoint ruler (par 4/5/doglegs)
            # and cached tee feature registration. These are local, provisional
            # observations independent of Python's limited course-layout scan.
            # Never interpret last_completed as authoritative current ball.
            diagnostic = waypoint_diagnostics.observe(
                cropped, ball, pin, window=window, frame_bgr=frame, roi=roi,
                state=state,
            )
            result["waypointRuler"] = diagnostic["waypointRuler"]
            result["registration"] = diagnostic["registration"]
            result["scale"] = diagnostic["scale"]
            result["timingMs"].update(diagnostic.get("timingMs", {}))
            if diagnostic["scale"]["status"] != "unavailable":
                return result
            shot, layout = state.get("shot", {}), state.get("layout", {})
            if shot.get("status") != "ready" or layout.get("status") != "ready":
                result["scale"] = {"status": "unavailable", "reason": "missing_fresh_world_or_layout"}
                return result

            # Crosscheck actual tee start against the output_log tee to reject a
            # stale layout or mismatched hole before claiming any real-world ruler.
            shot_world = shot.get("startingWorld")
            first_tee = shot.get("shotNumber") == 1 and shot.get("kind") == "pre_shot"
            if not shot_world:
                result["scale"] = {"status": "unavailable", "reason": "no_preshot_ball_world"}
                return result
            start_gap = _distance(shot_world, layout.get("teeWorld"))
            result["layoutTeeStartDeltaYds"] = start_gap
            if first_tee and start_gap is not None and start_gap > MAX_LAYOUT_ERROR_YDS:
                result["scale"] = {"status": "unavailable", "reason": "layout_tee_does_not_match_start"}
                return result

            # Diagnostic world-scale is not automatically an authoritative
            # registered OSM transform. It is still useful for tee/fairway.
            source_distance = _distance(shot_world, layout.get("pinWorld"), True)
            if source_distance is not None:
                world_ypp = source_distance / gap
                if 0.03 <= world_ypp <= 3.0:
                    result["scale"] = {
                        "status": "provisional_world_distance",
                        "yardsPerPixel": round(world_ypp, 5),
                        "source": "gspro-world-ball-pin-horizontal",
                        "reason": "Unverified pin pixel and layout binding; do not use for native click or OSM registration.",
                    }
            if first_tee and layout.get("par") == 3:
                try:
                    # At the tee on par 3 the direct physical-world distance
                    # avoids substituting routed scorecard yardages.
                    resolved = resolve_minimap_scale(
                        ball=Point(ball.x, ball.y), pin=Point(pin.x, pin.y),
                        pin_distance_yds=source_distance, par=3)
                    result["scale"] = {
                        "status": "provisional_par3",
                        "yardsPerPixel": round(resolved.yards_per_pixel, 5),
                        "source": resolved.source,
                        "reason": "Geometry-based scale only; native frame/capture validity must be proved on sim.",
                    }
                except (RuntimeError, ValueError) as exc:
                    result["scale"]["reason"] = str(exc)[:180]
            return result
        except (RuntimeError, ValueError, IndexError, cv2.error) as exc:
            errors.append(side + ": " + type(exc).__name__ + ": " + str(exc)[:120])
    result["status"] = "markers_unavailable"
    result["reason"] = "; ".join(errors)[:360] or "markers_not_detected"
    return result


def collect_observations(*, include_ocr=True, include_waypoints=True):
    """Public JSON without full file paths, images, local usernames, or raw log."""
    started = time.perf_counter()
    observed = now()
    window = native.find_gspro_window()
    folder = native.discover_gspro_data_directory(image_path=window.get("imagePath"))
    state = read_structured_state(folder)
    structured_ms = round((time.perf_counter() - started) * 1000, 2)
    # Capture GSPro HWND once. Timers include Windows process/system overhead,
    # not merely CV execution; the frame remains private to this request.
    capture_started = time.perf_counter()
    frame_report = capture.probe_gspro_capture(window, keep_pixels=True)
    capture_ms = round((time.perf_counter() - capture_started) * 1000, 2)
    minimap_started = time.perf_counter()
    minimap = _image_observation(window, state, report=frame_report, include_waypoints=include_waypoints)
    minimap_ms = round((time.perf_counter() - minimap_started) * 1000, 2)
    wind_ms = 0.0
    lie_ms = 0.0
    hud_ms = 0.0
    result = {
        "service": "looper-companion",
        "schemaVersion": "native-observations-v1",
        "status": "ready" if window.get("status") == "connected" else "unavailable",
        "observedAt": observed,
        "gspro": native.public_gspro_window_status(window),
        "dataFolder": native.public_data_folder_status(folder),
        "structured": state,
        "minimap": minimap,
        "ocr": {},
        "capabilities": {
            "windLie": "on_demand",
            "ballPinPixels": "read_only_diagnostic",
            "waypointScale": "native_bundled_tesseract_read_only",
            "zoomRegistration": "read_only_provisional",
            "osmRegistration": False,
            "autoAim": False,
        },
    }
    if include_ocr and window.get("status") == "connected":
        # The existing Windows HUD OCR readers run as separate bounded requests.
        # Individual OCR failures never prevent independent ball/world evidence.
        wind_started = time.perf_counter()
        try:
            wind = wind_ocr.read_wind_from_capture(frame_report)
            result["ocr"]["wind"] = {k: v for k, v in wind.items()
                                      if k not in ("capture", "ocrRawText")}
        except Exception as error:
            result["ocr"]["wind"] = {"status": "UNAVAILABLE",
                "observedAt": now(), "ocrSource": "gspro-native-window",
                "note": type(error).__name__}
        finally:
            wind_ms = round((time.perf_counter() - wind_started) * 1000, 2)
        hud_started = time.perf_counter()
        try:
            result["ocr"]["hud"] = hud_ocr.read_hud_from_capture(frame_report)
        except Exception as error:
            result["ocr"]["hud"] = {"status": "UNAVAILABLE", "observedAt": now(),
                                    "note": type(error).__name__}
        finally:
            hud_ms = round((time.perf_counter() - hud_started) * 1000, 2)
        # Lie now reads the same GSPro HWND frame as wind and minimap.
        lie_started = time.perf_counter()
        try:
            lie = lie_ocr.read_lie_from_capture(frame_report)
            result["ocr"]["lie"] = {k: v for k, v in lie.items()
                                     if k not in ("capture", "ocrRawText")}
        except Exception as error:
            result["ocr"]["lie"] = {"status": "UNAVAILABLE",
                "observedAt": now(), "note": type(error).__name__}
        finally:
            lie_ms = round((time.perf_counter() - lie_started) * 1000, 2)
    else:
        result["ocr"] = {key: {"status": "UNAVAILABLE", "observedAt": observed,
             "note": "GSPro not connected or OCR not requested."}
             for key in ("wind", "lie")}
    # Numeric observations only; no imagery, operating-system paths, logs or
    # native click/POST capability is serialized.
    result["timingMs"] = {
        "structuredDiscovery": structured_ms,
        "nativeCapture": capture_ms,
        "minimapTotal": minimap_ms,
        "markerDetection": minimap.get("timingMs", {}).get("markerDetection"),
        "waypointCalibrationAndRegistration": minimap.get("timingMs", {}).get(
            "waypointCalibrationAndRegistration"
        ),
        "waypointOcr": minimap.get("timingMs", {}).get("waypointOcr"),
        "scaleMath": minimap.get("timingMs", {}).get("scaleMath"),
        "zoomRegistration": minimap.get("timingMs", {}).get("zoomRegistration"),
        "windOcr": wind_ms,
        "lieOcr": lie_ms,
        "hudOcr": hud_ms,
        "total": round((time.perf_counter() - started) * 1000, 2),
    }
    return result
