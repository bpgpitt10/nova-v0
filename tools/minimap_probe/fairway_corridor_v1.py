#!/usr/bin/env python3
"""Landing-station fairway corridor extraction for Looper.

The old fairway experiment asked SAM2 for one whole-hole fairway polygon. That can
merge rough / neighboring fairways and create absurd cross-sections. This module
asks a narrower question that matches strategy use:

    At selected landing distances, where are the LEFT EDGE, CENTER, and RIGHT EDGE
    of the CURRENT-HOLE fairway?

A vision model sees a single annotated tee minimap with numbered station lines and
returns one edge triplet per station. Geometry is then validated in Looper's local
forward/right yard system and optionally snapped a few pixels to a strong local turf
edge. The result is a sparse, dogleg-aware corridor, not a replacement course map.

Offline replay only. No GSPro input. Strategy authority OFF.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
from pathlib import Path
import time
from typing import Any, Iterable
from urllib import error as urlerror
from urllib import request as urlrequest

import cv2
import numpy as np

import fairway_surface_shadow as fairway_surface
import hazard_vlm_openai as openai_adapter
import strategy_risk_v0 as risk

SCHEMA_VERSION = "looper-fairway-corridor-v1"
DEFAULT_LUNA_MODEL = "gpt-5.6-luna"
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
OPENAI_API_URL = openai_adapter.API_URL
GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
RETRYABLE_HTTP = {408, 409, 429, 500, 502, 503, 504}
DEFAULT_STATIONS = (160.0, 180.0, 200.0, 220.0, 240.0, 260.0, 280.0)
MAX_WIDTH_YDS = 90.0
MIN_WIDTH_YDS = 12.0
MAX_FORWARD_RESIDUAL_YDS = 12.0
MAX_CENTER_SHIFT_PER_20_YDS = 35.0
EDGE_SNAP_RADIUS_PX = 12
EDGE_SNAP_MIN_LAB_DELTA = 7.5

SYSTEM = """You analyze a GSPro golf-simulator TEE minimap for Looper.
The image contains numbered magenta station lines drawn across the hole at known
landing distances from the tee.

Your ONLY job is to identify the CURRENT-HOLE FAIRWAY where each numbered station
line crosses it. Do not trace the whole fairway. Do not use neighboring fairways.

For each station:
- present=true only if that line clearly crosses the current-hole fairway.
- left_xy_1000 is the golfer-left fairway edge on that station line.
- right_xy_1000 is the golfer-right fairway edge on that station line.
- center_xy_1000 is a reasonable center of that same current-hole fairway crossing.
- Coordinates are [x,y] in integer 0-1000 image coordinates.
- If the current-hole fairway is absent or ambiguous at that station, set present=false
  and use [0,0] for all three points.

Current-hole identity matters more than finding every green-looking surface. Ignore
neighboring-hole fairways, rough, greens, tee boxes, bunkers, water, cart paths,
roads, buildings, UI, red penalty lines, white OB lines, and marker dots.

This is strategy geometry. Prefer a missing station over confidently selecting the
wrong hole. Return only JSON matching the supplied schema."""


def _finite(value: Any, name: str) -> float:
    out = float(value)
    if not math.isfinite(out):
        raise ValueError(f"{name} must be finite")
    return out


def _xy(value: Any) -> tuple[float, float] | None:
    if isinstance(value, dict) and value.get("x") is not None and value.get("y") is not None:
        return float(value["x"]), float(value["y"])
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return float(value[0]), float(value[1])
    return None


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def find_source_image(capture: Path) -> Path:
    for name in (
        "tee_hazard_safe_minimap.png",
        "tee_canonical_minimap.png",
        "tee_initial_minimap.png",
        "watcher_prelaunch_minimap.png",
        "original_gspro_minimap.png",
        "tee_heatmap_minimap.png",
    ):
        p = capture / name
        if p.is_file():
            return p
    for metadata_name in ("screenshot_strategy_geometry_v2.json", "strategy_geometry_fixture_v0.json"):
        p = capture / metadata_name
        if not p.is_file():
            continue
        try:
            payload = read_json(p)
            visual = payload.get("visual_truth") or {}
            source = visual.get("source_image")
            if source and (capture / str(source)).is_file():
                return capture / str(source)
        except Exception:
            pass
    raise FileNotFoundError(f"No replayable GSPro tee minimap found in {capture}")


def load_strategy_geometry(capture: Path) -> dict[str, Any]:
    for name in ("screenshot_strategy_geometry_v2.json", "strategy_geometry_fixture_v0.json"):
        p = capture / name
        if p.is_file():
            payload = read_json(p)
            transform = payload.get("coordinate_transform") or {}
            if _xy(transform.get("tee_pixel")) and _xy(transform.get("pin_pixel")) and transform.get("yards_per_pixel"):
                return payload
    try:
        import screenshot_strategy_geometry_v2 as strategy_geometry
        return strategy_geometry.build(capture, force_red=False)
    except Exception as exc:
        raise RuntimeError(f"strategy geometry unavailable for {capture.name}: {exc}") from exc


def local_to_pixel(transform: dict[str, Any], lateral_yds: float, forward_yds: float) -> tuple[float, float]:
    tee = _xy(transform.get("tee_pixel"))
    pin = _xy(transform.get("pin_pixel"))
    if tee is None or pin is None:
        raise ValueError("strategy transform needs tee_pixel and pin_pixel")
    scale = _finite(transform.get("yards_per_pixel"), "yards_per_pixel")
    if scale <= 0:
        raise ValueError("yards_per_pixel must be > 0")
    tx, ty = tee
    px, py = pin
    dx, dy = px - tx, py - ty
    dist = math.hypot(dx, dy)
    if dist <= 1e-9:
        raise ValueError("tee and pin pixels coincide")
    fx, fy = dx / dist, dy / dist
    rx, ry = -fy, fx
    return (
        tx + (forward_yds * fx + lateral_yds * rx) / scale,
        ty + (forward_yds * fy + lateral_yds * ry) / scale,
    )


def pixel_to_local(transform: dict[str, Any], point: tuple[float, float]) -> tuple[float, float]:
    return risk.pixel_to_local(transform, point[0], point[1])


def station_pixel_segment(
    transform: dict[str, Any],
    forward_yds: float,
    *,
    lateral_extent_yds: float = 115.0,
) -> tuple[tuple[float, float], tuple[float, float]]:
    extent = abs(_finite(lateral_extent_yds, "lateral_extent_yds"))
    return (
        local_to_pixel(transform, -extent, forward_yds),
        local_to_pixel(transform, extent, forward_yds),
    )


def station_schema(count: int) -> dict[str, Any]:
    item = {
        "type": "object",
        "properties": {
            "station_id": {"type": "integer", "minimum": 1, "maximum": max(1, count)},
            "present": {"type": "boolean"},
            "left_xy_1000": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 1000}, "minItems": 2, "maxItems": 2},
            "center_xy_1000": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 1000}, "minItems": 2, "maxItems": 2},
            "right_xy_1000": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 1000}, "minItems": 2, "maxItems": 2},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "note": {"type": "string"},
        },
        "required": ["station_id", "present", "left_xy_1000", "center_xy_1000", "right_xy_1000", "confidence", "note"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {"stations": {"type": "array", "items": item, "minItems": count, "maxItems": count}},
        "required": ["stations"],
        "additionalProperties": False,
    }


def gemini_station_schema(count: int) -> dict[str, Any]:
    item = {
        "type": "object",
        "properties": {
            "station_id": {"type": "integer"},
            "present": {"type": "boolean"},
            "left_xy_1000": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
            "center_xy_1000": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
            "right_xy_1000": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
            "confidence": {"type": "number"},
            "note": {"type": "string"},
        },
        "required": ["station_id", "present", "left_xy_1000", "center_xy_1000", "right_xy_1000", "confidence", "note"],
    }
    return {
        "type": "object",
        "properties": {"stations": {"type": "array", "items": item, "minItems": count, "maxItems": count}},
        "required": ["stations"],
    }


def _norm_xy1000(value: Any, name: str) -> list[int]:
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(f"{name} must contain two coordinates")
    out = [int(value[0]), int(value[1])]
    if any(v < 0 or v > 1000 for v in out):
        raise ValueError(f"{name} outside [0,1000]")
    return out


def normalize_semantic(raw: dict[str, Any], station_count: int) -> list[dict[str, Any]]:
    rows = raw.get("stations") if isinstance(raw, dict) else None
    if not isinstance(rows, list) or len(rows) != station_count:
        raise ValueError(f"semantic response must contain exactly {station_count} stations")
    seen: set[int] = set()
    normalized = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("station row must be an object")
        station_id = int(row.get("station_id"))
        if not 1 <= station_id <= station_count or station_id in seen:
            raise ValueError("invalid or duplicate station_id")
        seen.add(station_id)
        present = bool(row.get("present"))
        confidence = float(row.get("confidence", 0.0))
        if not 0.0 <= confidence <= 1.0:
            raise ValueError("station confidence outside [0,1]")
        left = _norm_xy1000(row.get("left_xy_1000"), "left_xy_1000")
        center = _norm_xy1000(row.get("center_xy_1000"), "center_xy_1000")
        right = _norm_xy1000(row.get("right_xy_1000"), "right_xy_1000")
        if not present:
            left = center = right = [0, 0]
        normalized.append({
            "station_id": station_id,
            "present": present,
            "left_xy_1000": left,
            "center_xy_1000": center,
            "right_xy_1000": right,
            "confidence": confidence,
            "note": str(row.get("note") or "").strip() or None,
        })
    return sorted(normalized, key=lambda row: row["station_id"])


def call_luna(image_path: Path, *, station_count: int, model: str = DEFAULT_LUNA_MODEL, timeout_seconds: float = 70.0, retries: int = 3) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not available")
    image_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    body = {
        "model": model,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": SYSTEM}]},
            {"role": "user", "content": [
                {"type": "input_image", "image_url": f"data:{openai_adapter._mime(image_path)};base64,{image_b64}", "detail": "original"},
                {"type": "input_text", "text": f"Read all {station_count} numbered station lines. Return exactly one row for each station ID 1 through {station_count}."},
            ]},
        ],
        "text": {"format": {"type": "json_schema", "name": "looper_fairway_corridor_v1", "strict": True, "schema": station_schema(station_count)}},
        "reasoning": {"effort": "none"},
        "max_output_tokens": 4096,
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urlrequest.Request(OPENAI_API_URL, data=json.dumps(body).encode("utf-8"), headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            rows = normalize_semantic(json.loads(openai_adapter._extract_output_text(raw)), station_count)
            return rows, {"provider": "openai-luna", "model": model, "latency_seconds": time.perf_counter() - started, "response_id": raw.get("id"), "usage_metadata": raw.get("usage") or {}}
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last = RuntimeError(f"OpenAI HTTP {exc.code}: {detail[:1200]}")
            if exc.code not in RETRYABLE_HTTP or attempt + 1 >= retries:
                raise last
        except urlerror.URLError as exc:
            last = RuntimeError(f"OpenAI network error: {exc}")
            if attempt + 1 >= retries:
                raise last
        time.sleep(min(8.0, 1.25 * (2 ** attempt)))
    raise last or RuntimeError("Luna corridor localization failed")


def _gemini_output(payload: dict[str, Any]) -> dict[str, Any]:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    text = "".join(str(part.get("text") or "") for part in parts).strip()
    if not text:
        raise RuntimeError("Gemini returned no JSON")
    return json.loads(text)


def call_gemini(image_path: Path, *, station_count: int, model: str = DEFAULT_GEMINI_MODEL, timeout_seconds: float = 90.0, retries: int = 3) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not available")
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": openai_adapter._mime(image_path), "data": base64.b64encode(image_path.read_bytes()).decode("ascii")}},
            {"text": f"Read all {station_count} numbered station lines and return exactly one row for each station ID."},
        ]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": gemini_station_schema(station_count), "maxOutputTokens": 4096, "thinkingConfig": {"thinkingLevel": "minimal"}},
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urlrequest.Request(f"{GEMINI_API_ROOT}/{model}:generateContent", data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json", "x-goog-api-key": key}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            rows = normalize_semantic(_gemini_output(raw), station_count)
            return rows, {"provider": "google-gemini", "model": model, "latency_seconds": time.perf_counter() - started, "usage_metadata": raw.get("usageMetadata") or {}}
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last = RuntimeError(f"Gemini HTTP {exc.code}: {detail[:1200]}")
            if exc.code not in RETRYABLE_HTTP or attempt + 1 >= retries:
                raise last
        except urlerror.URLError as exc:
            last = RuntimeError(f"Gemini network error: {exc}")
            if attempt + 1 >= retries:
                raise last
        time.sleep(min(8.0, 1.5 * (2 ** attempt)))
    raise last or RuntimeError("Gemini corridor localization failed")


def call_provider_chain(image_path: Path, *, station_count: int, provider: str = "luna", fallback_provider: str | None = "gemini") -> tuple[list[dict[str, Any]], dict[str, Any]]:
    chain = [provider]
    if fallback_provider and fallback_provider.lower() != provider.lower():
        chain.append(fallback_provider)
    attempts = []
    last: Exception | None = None
    for index, name in enumerate(chain):
        try:
            if name.lower() in {"luna", "openai"}:
                rows, meta = call_luna(image_path, station_count=station_count)
            elif name.lower() in {"gemini", "google"}:
                rows, meta = call_gemini(image_path, station_count=station_count)
            else:
                raise ValueError(f"unsupported provider {name!r}")
            attempts.append({"provider": name, "status": "complete", "latency_seconds": meta.get("latency_seconds")})
            return rows, {**meta, "provider_attempts": attempts, "fallback_used": index > 0}
        except Exception as exc:
            last = exc
            attempts.append({"provider": name, "status": "error", "error": f"{type(exc).__name__}: {exc}"})
    raise RuntimeError(f"all corridor providers failed: {attempts}") from last


def annotate_stations(image: np.ndarray, transform: dict[str, Any], stations_yds: list[float]) -> np.ndarray:
    out = image.copy()
    h, w = out.shape[:2]
    for index, forward in enumerate(stations_yds, start=1):
        a, b = station_pixel_segment(transform, forward)
        p1 = (int(round(a[0])), int(round(a[1])))
        p2 = (int(round(b[0])), int(round(b[1])))
        cv2.line(out, p1, p2, (255, 0, 255), 2, cv2.LINE_AA)
        x = max(3, min(w - 55, p1[0] + 5))
        y = max(18, min(h - 5, p1[1] - 5))
        label = f"S{index} {int(round(forward))}y"
        cv2.putText(out, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.46, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(out, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.46, (255, 0, 255), 1, cv2.LINE_AA)
    return out


def xy1000_to_pixel(xy: list[int], width: int, height: int) -> tuple[float, float]:
    return (float(xy[0]) / 1000.0 * width, float(xy[1]) / 1000.0 * height)


def _sample_lab(image_lab: np.ndarray, point: tuple[float, float], radius: int = 2) -> np.ndarray:
    x, y = int(round(point[0])), int(round(point[1]))
    h, w = image_lab.shape[:2]
    x1, x2 = max(0, x - radius), min(w, x + radius + 1)
    y1, y2 = max(0, y - radius), min(h, y + radius + 1)
    if x1 >= x2 or y1 >= y2:
        return np.zeros(3, dtype=np.float32)
    return image_lab[y1:y2, x1:x2].reshape(-1, 3).mean(axis=0)


def snap_edge_along_station(image: np.ndarray, transform: dict[str, Any], *, forward_yds: float, edge_lateral_yds: float, center_lateral_yds: float, radius_px: int = EDGE_SNAP_RADIUS_PX, min_lab_delta: float = EDGE_SNAP_MIN_LAB_DELTA) -> tuple[float, dict[str, Any]]:
    scale = _finite(transform.get("yards_per_pixel"), "yards_per_pixel")
    direction = 1.0 if center_lateral_yds > edge_lateral_yds else -1.0
    image_lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    best = (0.0, edge_lateral_yds)
    for delta_px in range(-int(radius_px), int(radius_px) + 1):
        candidate_lat = edge_lateral_yds + delta_px * scale
        inside_lat = candidate_lat + direction * 4.0 * scale
        outside_lat = candidate_lat - direction * 4.0 * scale
        inside = _sample_lab(image_lab, local_to_pixel(transform, inside_lat, forward_yds), radius=2)
        outside = _sample_lab(image_lab, local_to_pixel(transform, outside_lat, forward_yds), radius=2)
        score = float(np.linalg.norm(inside - outside))
        if score > best[0]:
            best = (score, candidate_lat)
    accepted = best[0] >= float(min_lab_delta)
    return (best[1] if accepted else edge_lateral_yds), {"attempted": True, "accepted": accepted, "lab_delta": best[0], "shift_yds": (best[1] - edge_lateral_yds) if accepted else 0.0, "radius_px": int(radius_px)}


def validate_station(row: dict[str, Any], *, expected_forward_yds: float, transform: dict[str, Any], image_width: int, image_height: int, image: np.ndarray | None = None) -> dict[str, Any]:
    result = {"station_id": int(row["station_id"]), "forward_yds": float(expected_forward_yds), "present": bool(row.get("present")), "semantic_confidence": float(row.get("confidence", 0.0)), "note": row.get("note"), "accepted": False, "rejection_reasons": [], "warnings": [], "strategy_authority": False}
    if not result["present"]:
        result["rejection_reasons"].append("semantic-no-current-hole-fairway")
        return result
    points_px = {name: xy1000_to_pixel(row[f"{name}_xy_1000"], image_width, image_height) for name in ("left", "center", "right")}
    points_local = {name: pixel_to_local(transform, point) for name, point in points_px.items()}
    expected = float(expected_forward_yds)
    for name, (_lat, fwd) in points_local.items():
        if abs(fwd - expected) > MAX_FORWARD_RESIDUAL_YDS:
            result["rejection_reasons"].append(f"{name}-off-station-line")
    left_lat = points_local["left"][0]
    center_lat = points_local["center"][0]
    right_lat = points_local["right"][0]
    if not left_lat < right_lat:
        result["rejection_reasons"].append("left-right-order-invalid")
    width = right_lat - left_lat
    if width < MIN_WIDTH_YDS:
        result["rejection_reasons"].append("corridor-too-narrow")
    if width > MAX_WIDTH_YDS:
        result["rejection_reasons"].append("corridor-too-wide")
    if not left_lat <= center_lat <= right_lat:
        result["rejection_reasons"].append("center-outside-edges")
    snap = {}
    if image is not None and not result["rejection_reasons"]:
        snapped_left, snap_left = snap_edge_along_station(image, transform, forward_yds=expected, edge_lateral_yds=left_lat, center_lateral_yds=center_lat)
        snapped_right, snap_right = snap_edge_along_station(image, transform, forward_yds=expected, edge_lateral_yds=right_lat, center_lateral_yds=center_lat)
        snap = {"left": snap_left, "right": snap_right}
        if snapped_left < snapped_right:
            left_lat, right_lat = snapped_left, snapped_right
            width = right_lat - left_lat
            center_lat = min(right_lat, max(left_lat, center_lat))
            if width > MAX_WIDTH_YDS:
                result["warnings"].append("edge-snap-created-wide-corridor; semantic edges retained")
                left_lat = points_local["left"][0]
                right_lat = points_local["right"][0]
                center_lat = points_local["center"][0]
                width = right_lat - left_lat
        else:
            result["warnings"].append("edge-snap-order-invalid; semantic edges retained")
    result.update({"accepted": not result["rejection_reasons"], "left_lateral_yds": left_lat, "center_lateral_yds": center_lat, "right_lateral_yds": right_lat, "width_yds": width, "semantic_points_pixel": {name: [point[0], point[1]] for name, point in points_px.items()}, "semantic_points_local": {name: {"lateral_yds": value[0], "forward_yds": value[1]} for name, value in points_local.items()}, "edge_snap": snap})
    return result


def apply_continuity_qa(stations: list[dict[str, Any]]) -> None:
    accepted = [row for row in stations if row.get("accepted")]
    for previous, current in zip(accepted, accepted[1:]):
        df = float(current["forward_yds"]) - float(previous["forward_yds"])
        if df <= 0:
            current.setdefault("warnings", []).append("non-increasing-forward-order")
            continue
        dc = abs(float(current["center_lateral_yds"]) - float(previous["center_lateral_yds"]))
        allowed = MAX_CENTER_SHIFT_PER_20_YDS * (df / 20.0)
        if dc > allowed:
            current.setdefault("warnings", []).append(f"centerline-jump:{dc:.1f}yd over {df:.0f}yd forward (limit {allowed:.1f})")


def draw_result_overlay(image: np.ndarray, transform: dict[str, Any], stations: list[dict[str, Any]]) -> np.ndarray:
    out = image.copy()
    for row in stations:
        forward = float(row["forward_yds"])
        a, b = station_pixel_segment(transform, forward)
        line_color = (90, 90, 90) if not row.get("accepted") else (190, 80, 190)
        cv2.line(out, tuple(map(round, a)), tuple(map(round, b)), line_color, 1, cv2.LINE_AA)
        if not row.get("accepted"):
            continue
        pts = []
        for key, color in (("left_lateral_yds", (0, 255, 255)), ("center_lateral_yds", (255, 255, 255)), ("right_lateral_yds", (0, 255, 255))):
            px = local_to_pixel(transform, float(row[key]), forward)
            point = (int(round(px[0])), int(round(px[1])))
            pts.append(point)
            cv2.circle(out, point, 5 if "center" in key else 4, color, -1, cv2.LINE_AA)
        cv2.line(out, pts[0], pts[2], (0, 220, 255), 3, cv2.LINE_AA)
        label = f"{int(round(forward))}y {row['width_yds']:.0f}w"
        cv2.putText(out, label, (pts[0][0] + 4, pts[0][1] - 7), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(out, label, (pts[0][0] + 4, pts[0][1] - 7), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 220, 255), 1, cv2.LINE_AA)
    return out


def dynamic_stations(geometry: dict[str, Any], requested: Iterable[float] | None = None) -> list[float]:
    if requested:
        return sorted({round(_finite(value, "station"), 3) for value in requested if float(value) > 0})
    transform = geometry.get("coordinate_transform") or {}
    tee = _xy(transform.get("tee_pixel"))
    pin = _xy(transform.get("pin_pixel"))
    scale = transform.get("yards_per_pixel")
    if tee and pin and scale:
        tee_pin_yds = math.hypot(pin[0] - tee[0], pin[1] - tee[1]) * float(scale)
        max_station = min(300.0, max(180.0, tee_pin_yds - 70.0))
        values = [value for value in DEFAULT_STATIONS if value <= max_station]
        if values:
            return values
    return list(DEFAULT_STATIONS)


def extract_capture(capture: Path, *, stations_yds: Iterable[float] | None = None, provider: str = "luna", fallback_provider: str | None = "gemini", force: bool = False) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    output_path = capture / "fairway_corridor_v1.json"
    if output_path.is_file() and not force:
        return read_json(output_path)
    geometry = load_strategy_geometry(capture)
    transform = geometry.get("coordinate_transform") or {}
    source = find_source_image(capture)
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {source}")
    stations = dynamic_stations(geometry, stations_yds)
    if not stations:
        raise RuntimeError("no corridor stations requested")
    annotated = annotate_stations(image, transform, stations)
    prompt_name = "fairway_corridor_prompt_v1.png"
    cv2.imwrite(str(capture / prompt_name), annotated)
    semantic_rows, provider_meta = call_provider_chain(capture / prompt_name, station_count=len(stations), provider=provider, fallback_provider=fallback_provider)
    validated = [validate_station(row, expected_forward_yds=stations[index], transform=transform, image_width=image.shape[1], image_height=image.shape[0], image=image) for index, row in enumerate(semantic_rows)]
    apply_continuity_qa(validated)
    accepted = [row for row in validated if row.get("accepted")]
    warnings = []
    if len(accepted) < max(2, math.ceil(len(stations) * 0.5)):
        warnings.append("low-station-coverage")
    if any(row.get("warnings") for row in accepted):
        warnings.append("station-continuity-or-snap-warning")
    overlay = draw_result_overlay(image, transform, validated)
    overlay_name = "fairway_corridor_overlay_v1.png"
    cv2.imwrite(str(capture / overlay_name), overlay)
    identity = geometry.get("identity") or {"capture_id": capture.name}
    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": identity,
        "visual_truth": {"source_image": source.name},
        "prompt_artifact": prompt_name,
        "overlay_artifact": overlay_name,
        "coordinate_transform": transform,
        "stations_requested_yds": stations,
        "stations": validated,
        "accepted_station_count": len(accepted),
        "requested_station_count": len(stations),
        "provider": provider_meta,
        "qa": {"min_width_yds": MIN_WIDTH_YDS, "max_width_yds": MAX_WIDTH_YDS, "max_forward_residual_yds": MAX_FORWARD_RESIDUAL_YDS, "max_center_shift_per_20yd": MAX_CENTER_SHIFT_PER_20_YDS, "warnings": warnings},
        "interpretation": {"corridor": "sparse current-hole fairway edge/center samples at strategy landing stations", "not_a_course_reconstruction": True, "not_a_recommendation": True},
        "strategy_authority": False,
        "recommendation": None,
    }
    write_json(output_path, payload)
    return payload


def capture_dirs(roots: Iterable[str]) -> list[Path]:
    rows: list[Path] = []
    for raw in roots:
        p = Path(raw).expanduser().resolve()
        if p.is_dir() and (p.name.startswith("tee_capture_") or (p / "strategy_geometry_fixture_v0.json").is_file()):
            rows.append(p)
        elif p.is_dir():
            rows.extend(x for x in p.iterdir() if x.is_dir() and (x.name.startswith("tee_capture_") or (x / "strategy_geometry_fixture_v0.json").is_file()))
    return sorted(set(rows), key=lambda p: p.stat().st_mtime)


def parse_station_list(value: str | None) -> list[float] | None:
    if not value:
        return None
    return [float(part.strip()) for part in value.split(",") if part.strip()]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Extract a sparse current-hole fairway corridor at landing stations")
    p.add_argument("--capture-root", action="append", default=[])
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--stations", help="Comma-separated forward yard stations; default is dynamic 160-280y")
    p.add_argument("--provider", default="luna")
    p.add_argument("--fallback-provider", default="gemini")
    p.add_argument("--latest", type=int, default=0)
    p.add_argument("--force", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    captures = capture_dirs([*args.capture_root, *args.capture_dir])
    if args.latest > 0:
        captures = captures[-args.latest:]
    if not captures:
        print("No replayable tee capture folders found.")
        return 1
    stations = parse_station_list(args.stations)
    errors = 0
    print("Looper Fairway Corridor v1")
    print("Landing-station current-hole edges; no whole-hole redraw; no GSPro input; strategy authority OFF.")
    for capture in captures:
        try:
            payload = extract_capture(capture, stations_yds=stations, provider=args.provider, fallback_provider=(args.fallback_provider or None), force=args.force)
            ident = payload.get("identity") or {}
            widths = [row.get("width_yds") for row in payload.get("stations") or [] if row.get("accepted")]
            width_text = "n/a" if not widths else f"{min(widths):.0f}-{max(widths):.0f}yd"
            print(f"H{ident.get('hole_display','?')} corridor={payload.get('accepted_station_count',0)}/{payload.get('requested_station_count',0)} | widths={width_text} | {capture.name}")
        except Exception as exc:
            errors += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("Strategy authority: OFF | Recommendation: NONE")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
