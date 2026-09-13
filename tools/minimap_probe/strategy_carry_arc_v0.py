#!/usr/bin/env python3
"""Carry-arc fairway intersection extractor for Looper strategy work.

Why this exists:
The old fairway corridor experiment used straight cross-sections perpendicular to the
tee->pin axis. That is not the same thing as a golf landing locus and fails badly on
doglegs. A club with N yards of carry can land anywhere on a circle of radius N
around the current ball. This module asks a narrower, physically correct question:

    Where does the N-yard carry arc intersect the CURRENT-HOLE fairway?

Luna supplies semantic edge/center points on one lightly annotated carry arc at a
time. Looper validates those points in the screenshot/world transform and preserves
the original GSPro minimap as visual truth.

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

import hazard_vlm_openai as openai_adapter
import strategy_risk_v0 as risk

SCHEMA_VERSION = "looper-strategy-carry-arc-v0"
DEFAULT_LUNA_MODEL = "gpt-5.6-luna"
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
OPENAI_API_URL = openai_adapter.API_URL
GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
RETRYABLE_HTTP = {408, 409, 429, 500, 502, 503, 504}

DEFAULT_CARRIES = (200.0, 230.0, 260.0)
MAX_SPANS = 3
MAX_RADIAL_RESIDUAL_YDS = 10.0
MIN_CHORD_WIDTH_YDS = 8.0
MAX_CHORD_WIDTH_YDS = 100.0
MIN_FORWARD_COMPONENT_YDS = 20.0

SYSTEM = """You analyze a GSPro golf-simulator TEE minimap for Looper.

The image contains ONE thin dashed magenta carry arc centered on the current player
marker. Every point on that arc is the same carry distance from the ball.

Your ONLY job is to identify the CURRENT-HOLE FAIRWAY where that highlighted carry
arc crosses it.

Important:
- The current hole starts at the player/ball marker and progresses toward the white
  pin marker. Use that route to distinguish the current hole from neighboring holes.
- Return every plausible contiguous CURRENT-HOLE fairway span intersected by the
  magenta arc, up to three spans.
- For each span, edge_a_xy_1000 and edge_b_xy_1000 are the two visible fairway edges
  on the highlighted carry arc. center_xy_1000 is a point on the same arc near the
  middle of that fairway span.
- Coordinates are [x,y] in integer 0-1000 image coordinates.
- Do NOT select rough, green, tee boxes, bunkers, water, cart paths, roads, buildings,
  UI, red penalty lines, white OB lines, or an unrelated neighboring-hole fairway.
- A fairway may curve sharply. The carry arc is intentionally curved; do not replace
  it with a straight tee-to-pin cross-section.
- If the highlighted carry arc does not visibly cross the current-hole fairway, return
  present=false with an empty spans array.
- Use only visible screenshot evidence. Course identity or expectations must never
  create geometry that is not visible.

Return only structured JSON matching the supplied schema.
"""


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
        "gspro_minimap_visual_truth.png",
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
            source = (payload.get("visual_truth") or {}).get("source_image")
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


def xy1000_to_pixel(xy: list[int], width: int, height: int) -> tuple[float, float]:
    return float(xy[0]) / 1000.0 * width, float(xy[1]) / 1000.0 * height


def pixel_to_xy1000(point: tuple[float, float], width: int, height: int) -> list[int]:
    x = max(0, min(1000, int(round(point[0] / max(1, width) * 1000.0))))
    y = max(0, min(1000, int(round(point[1] / max(1, height) * 1000.0))))
    return [x, y]


def _norm_xy1000(value: Any, name: str) -> list[int]:
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(f"{name} must contain two coordinates")
    out = [int(value[0]), int(value[1])]
    if any(v < 0 or v > 1000 for v in out):
        raise ValueError(f"{name} outside [0,1000]")
    return out


def semantic_schema() -> dict[str, Any]:
    span = {
        "type": "object",
        "properties": {
            "span_id": {"type": "integer", "minimum": 1, "maximum": MAX_SPANS},
            "edge_a_xy_1000": {
                "type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 1000},
                "minItems": 2, "maxItems": 2,
            },
            "center_xy_1000": {
                "type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 1000},
                "minItems": 2, "maxItems": 2,
            },
            "edge_b_xy_1000": {
                "type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 1000},
                "minItems": 2, "maxItems": 2,
            },
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "note": {"type": "string"},
        },
        "required": ["span_id", "edge_a_xy_1000", "center_xy_1000", "edge_b_xy_1000", "confidence", "note"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "present": {"type": "boolean"},
            "spans": {"type": "array", "items": span, "minItems": 0, "maxItems": MAX_SPANS},
            "note": {"type": "string"},
        },
        "required": ["present", "spans", "note"],
        "additionalProperties": False,
    }


def gemini_semantic_schema() -> dict[str, Any]:
    span = {
        "type": "object",
        "properties": {
            "span_id": {"type": "integer"},
            "edge_a_xy_1000": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
            "center_xy_1000": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
            "edge_b_xy_1000": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
            "confidence": {"type": "number"},
            "note": {"type": "string"},
        },
        "required": ["span_id", "edge_a_xy_1000", "center_xy_1000", "edge_b_xy_1000", "confidence", "note"],
    }
    return {
        "type": "object",
        "properties": {
            "present": {"type": "boolean"},
            "spans": {"type": "array", "items": span},
            "note": {"type": "string"},
        },
        "required": ["present", "spans", "note"],
    }


def normalize_semantic(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("semantic response must be an object")
    present = bool(raw.get("present"))
    spans_raw = raw.get("spans")
    if not isinstance(spans_raw, list):
        raise ValueError("spans must be a list")
    if len(spans_raw) > MAX_SPANS:
        raise ValueError("too many fairway spans")
    spans = []
    seen = set()
    for row in spans_raw:
        if not isinstance(row, dict):
            raise ValueError("span row must be an object")
        sid = int(row.get("span_id"))
        if sid < 1 or sid > MAX_SPANS or sid in seen:
            raise ValueError("invalid or duplicate span_id")
        seen.add(sid)
        conf = float(row.get("confidence", 0.0))
        if not 0.0 <= conf <= 1.0:
            raise ValueError("span confidence outside [0,1]")
        spans.append({
            "span_id": sid,
            "edge_a_xy_1000": _norm_xy1000(row.get("edge_a_xy_1000"), "edge_a_xy_1000"),
            "center_xy_1000": _norm_xy1000(row.get("center_xy_1000"), "center_xy_1000"),
            "edge_b_xy_1000": _norm_xy1000(row.get("edge_b_xy_1000"), "edge_b_xy_1000"),
            "confidence": conf,
            "note": str(row.get("note") or "").strip() or None,
        })
    if present and not spans:
        raise ValueError("present=true requires at least one span")
    if not present:
        spans = []
    return {"present": present, "spans": sorted(spans, key=lambda x: x["span_id"]), "note": str(raw.get("note") or "").strip() or None}


def call_luna(image_path: Path, *, carry_yds: float, model: str = DEFAULT_LUNA_MODEL, timeout_seconds: float = 70.0, retries: int = 3) -> tuple[dict[str, Any], dict[str, Any]]:
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
                {"type": "input_text", "text": f"The highlighted dashed magenta arc is exactly {carry_yds:.0f} yards from the current ball. Identify only the CURRENT-HOLE fairway span or spans crossed by this arc."},
            ]},
        ],
        "text": {"format": {"type": "json_schema", "name": "looper_strategy_carry_arc_v0", "strict": True, "schema": semantic_schema()}},
        "reasoning": {"effort": "none"},
        "max_output_tokens": 2048,
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urlrequest.Request(OPENAI_API_URL, data=json.dumps(body).encode("utf-8"),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            result = normalize_semantic(json.loads(openai_adapter._extract_output_text(raw)))
            return result, {
                "provider": "openai-luna", "model": model,
                "latency_seconds": time.perf_counter() - started,
                "response_id": raw.get("id"), "usage_metadata": raw.get("usage") or {},
            }
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
    raise last or RuntimeError("Luna carry-arc localization failed")


def _gemini_output(payload: dict[str, Any]) -> dict[str, Any]:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    text = "".join(str(part.get("text") or "") for part in parts).strip()
    if not text:
        raise RuntimeError("Gemini returned no JSON")
    return json.loads(text)


def call_gemini(image_path: Path, *, carry_yds: float, model: str = DEFAULT_GEMINI_MODEL, timeout_seconds: float = 90.0, retries: int = 3) -> tuple[dict[str, Any], dict[str, Any]]:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not available")
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": openai_adapter._mime(image_path), "data": base64.b64encode(image_path.read_bytes()).decode("ascii")}},
            {"text": f"The highlighted dashed magenta arc is exactly {carry_yds:.0f} yards from the current ball. Identify only the CURRENT-HOLE fairway span or spans crossed by this arc."},
        ]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": gemini_semantic_schema(),
            "maxOutputTokens": 2048,
            "thinkingConfig": {"thinkingLevel": "minimal"},
        },
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urlrequest.Request(f"{GEMINI_API_ROOT}/{model}:generateContent",
                                 data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            return normalize_semantic(_gemini_output(raw)), {
                "provider": "google-gemini", "model": model,
                "latency_seconds": time.perf_counter() - started,
                "usage_metadata": raw.get("usageMetadata") or {},
            }
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
    raise last or RuntimeError("Gemini carry-arc localization failed")


def call_provider_chain(image_path: Path, *, carry_yds: float, provider: str = "luna", fallback_provider: str | None = "gemini") -> tuple[dict[str, Any], dict[str, Any]]:
    chain = [provider]
    if fallback_provider and fallback_provider.lower() != provider.lower():
        chain.append(fallback_provider)
    attempts = []
    last: Exception | None = None
    for index, name in enumerate(chain):
        try:
            if name.lower() in {"luna", "openai"}:
                result, meta = call_luna(image_path, carry_yds=carry_yds)
            elif name.lower() in {"gemini", "google"}:
                result, meta = call_gemini(image_path, carry_yds=carry_yds)
            else:
                raise ValueError(f"unsupported provider {name!r}")
            attempts.append({"provider": name, "status": "complete", "latency_seconds": meta.get("latency_seconds")})
            return result, {**meta, "provider_attempts": attempts, "fallback_used": index > 0}
        except Exception as exc:
            last = exc
            attempts.append({"provider": name, "status": "error", "error": f"{type(exc).__name__}: {exc}"})
    raise RuntimeError(f"all carry-arc providers failed: {attempts}") from last


def draw_dashed_circle(image: np.ndarray, center: tuple[float, float], radius_px: float) -> np.ndarray:
    out = image.copy()
    c = (int(round(center[0])), int(round(center[1])))
    r = int(round(radius_px))
    for start in range(0, 360, 9):
        cv2.ellipse(out, c, (r, r), 0, start, min(360, start + 4), (255, 0, 255), 2, cv2.LINE_AA)
    cv2.circle(out, c, 7, (0, 255, 255), 2, cv2.LINE_AA)
    return out


def annotate_carry_arc(image: np.ndarray, transform: dict[str, Any], carry_yds: float, origin_local: tuple[float, float] = (0.0, 0.0)) -> np.ndarray:
    origin_px = local_to_pixel(transform, origin_local[0], origin_local[1])
    scale = _finite(transform.get("yards_per_pixel"), "yards_per_pixel")
    out = draw_dashed_circle(image, origin_px, carry_yds / scale)
    label = f"{int(round(carry_yds))}y carry"
    cv2.putText(out, label, (10, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.74, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(out, label, (10, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.74, (255, 0, 255), 2, cv2.LINE_AA)
    return out


def _angle_from_origin(point_local: tuple[float, float], origin_local: tuple[float, float]) -> float:
    lat = point_local[0] - origin_local[0]
    fwd = point_local[1] - origin_local[1]
    return math.atan2(lat, fwd)


def _project_to_radius(point_local: tuple[float, float], origin_local: tuple[float, float], carry_yds: float) -> tuple[float, float]:
    dx = point_local[0] - origin_local[0]
    dy = point_local[1] - origin_local[1]
    d = math.hypot(dx, dy)
    if d <= 1e-9:
        raise ValueError("semantic point coincides with carry origin")
    scale = carry_yds / d
    return origin_local[0] + dx * scale, origin_local[1] + dy * scale


def _unwrap_between(a: float, b: float, c: float) -> bool:
    """True if b lies on the shorter angular arc from a to c."""
    def wrap(x: float) -> float:
        while x <= -math.pi:
            x += 2 * math.pi
        while x > math.pi:
            x -= 2 * math.pi
        return x
    ac = wrap(c - a)
    ab = wrap(b - a)
    if ac >= 0:
        return -1e-6 <= ab <= ac + 1e-6
    return ac - 1e-6 <= ab <= 1e-6


def validate_span(row: dict[str, Any], *, carry_yds: float, transform: dict[str, Any],
                  image_width: int, image_height: int, origin_local: tuple[float, float] = (0.0, 0.0)) -> dict[str, Any]:
    result = {
        "span_id": int(row["span_id"]),
        "semantic_confidence": float(row.get("confidence", 0.0)),
        "note": row.get("note"),
        "accepted": False,
        "rejection_reasons": [],
        "warnings": [],
        "strategy_authority": False,
    }
    raw_px = {
        "edge_a": xy1000_to_pixel(row["edge_a_xy_1000"], image_width, image_height),
        "center": xy1000_to_pixel(row["center_xy_1000"], image_width, image_height),
        "edge_b": xy1000_to_pixel(row["edge_b_xy_1000"], image_width, image_height),
    }
    raw_local = {name: pixel_to_local(transform, point) for name, point in raw_px.items()}
    projected = {}
    residuals = {}
    for name, point in raw_local.items():
        radius = math.hypot(point[0] - origin_local[0], point[1] - origin_local[1])
        residuals[name] = radius - carry_yds
        if abs(residuals[name]) > MAX_RADIAL_RESIDUAL_YDS:
            result["rejection_reasons"].append(f"{name}-off-carry-arc")
        try:
            projected[name] = _project_to_radius(point, origin_local, carry_yds)
        except Exception:
            result["rejection_reasons"].append(f"{name}-invalid-radius")
    if len(projected) == 3:
        if min(projected[name][1] - origin_local[1] for name in projected) < MIN_FORWARD_COMPONENT_YDS:
            result["rejection_reasons"].append("span-not-on-forward-landing-half")
        angles = {name: _angle_from_origin(point, origin_local) for name, point in projected.items()}
        if not (_unwrap_between(angles["edge_a"], angles["center"], angles["edge_b"]) or
                _unwrap_between(angles["edge_b"], angles["center"], angles["edge_a"])):
            result["rejection_reasons"].append("center-not-between-edges-on-arc")
        chord = math.dist(projected["edge_a"], projected["edge_b"])
        if chord < MIN_CHORD_WIDTH_YDS:
            result["rejection_reasons"].append("fairway-span-too-narrow")
        if chord > MAX_CHORD_WIDTH_YDS:
            result["rejection_reasons"].append("fairway-span-too-wide")
        edge_points = sorted([projected["edge_a"], projected["edge_b"]], key=lambda p: p[0])
        result.update({
            "left_local_yards": {"lateral": edge_points[0][0], "forward": edge_points[0][1]},
            "center_local_yards": {"lateral": projected["center"][0], "forward": projected["center"][1]},
            "right_local_yards": {"lateral": edge_points[1][0], "forward": edge_points[1][1]},
            "chord_width_yds": chord,
            "angles_radians": angles,
        })
    result.update({
        "semantic_points_pixel": {k: [v[0], v[1]] for k, v in raw_px.items()},
        "semantic_points_local": {k: {"lateral": v[0], "forward": v[1]} for k, v in raw_local.items()},
        "radial_residual_yds": residuals,
        "accepted": not result["rejection_reasons"],
    })
    return result


def _draw_arc_segment(image: np.ndarray, transform: dict[str, Any], carry_yds: float,
                      a_local: tuple[float, float], b_local: tuple[float, float],
                      origin_local: tuple[float, float] = (0.0, 0.0)) -> None:
    a = math.degrees(_angle_from_origin(a_local, origin_local))
    b = math.degrees(_angle_from_origin(b_local, origin_local))
    da = ((b - a + 180) % 360) - 180
    points = []
    for t in np.linspace(0.0, 1.0, 80):
        theta = math.radians(a + da * t)
        lat = origin_local[0] + carry_yds * math.sin(theta)
        fwd = origin_local[1] + carry_yds * math.cos(theta)
        px = local_to_pixel(transform, lat, fwd)
        points.append([int(round(px[0])), int(round(px[1]))])
    if len(points) >= 2:
        cv2.polylines(image, [np.asarray(points, dtype=np.int32).reshape((-1, 1, 2))], False, (0, 220, 255), 4, cv2.LINE_AA)


def draw_result_overlay(image: np.ndarray, transform: dict[str, Any], carry_yds: float,
                        spans: list[dict[str, Any]], origin_local: tuple[float, float] = (0.0, 0.0)) -> np.ndarray:
    out = annotate_carry_arc(image, transform, carry_yds, origin_local=origin_local)
    for span in spans:
        if not span.get("accepted"):
            continue
        left = span["left_local_yards"]
        right = span["right_local_yards"]
        center = span["center_local_yards"]
        left_pt = (float(left["lateral"]), float(left["forward"]))
        right_pt = (float(right["lateral"]), float(right["forward"]))
        center_pt = (float(center["lateral"]), float(center["forward"]))
        _draw_arc_segment(out, transform, carry_yds, left_pt, right_pt, origin_local=origin_local)
        for point, color, radius in ((left_pt, (0, 255, 255), 4), (center_pt, (255, 255, 255), 5), (right_pt, (0, 255, 255), 4)):
            px = local_to_pixel(transform, point[0], point[1])
            cv2.circle(out, (int(round(px[0])), int(round(px[1]))), radius, color, -1, cv2.LINE_AA)
    return out


def hole_metadata(capture: Path) -> dict[str, Any]:
    out = {}
    for name in ("capture_context.json", "hole_model.json"):
        p = capture / name
        if not p.is_file():
            continue
        try:
            raw = read_json(p)
        except Exception:
            continue
        if name == "capture_context.json":
            out["par"] = raw.get("par")
            out["hole_yards"] = raw.get("original_hole_yards")
            out["hole_display"] = raw.get("hole_number")
            out["course_name"] = raw.get("course_name")
        else:
            bg = raw.get("base_geometry") or {}
            out["hole_yards"] = out.get("hole_yards") or bg.get("pin_distance_yds")
    return out


def eligible_carries(capture: Path, requested: Iterable[float]) -> list[float]:
    meta = hole_metadata(capture)
    par = meta.get("par")
    if par in {3, "3"}:
        return []
    hole_yards = meta.get("hole_yards")
    values = sorted({round(float(x), 3) for x in requested if float(x) > 0})
    if hole_yards is None:
        return values
    return [x for x in values if x <= float(hole_yards) - 35.0]


def extract_carry(capture: Path, *, carry_yds: float, provider: str = "luna",
                  fallback_provider: str | None = "gemini", origin_local: tuple[float, float] = (0.0, 0.0),
                  force: bool = False) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    carry_key = int(round(carry_yds))
    output_path = capture / f"strategy_carry_arc_{carry_key:04d}_v0.json"
    if output_path.is_file() and not force:
        return read_json(output_path)
    geometry = load_strategy_geometry(capture)
    transform = geometry.get("coordinate_transform") or {}
    source = find_source_image(capture)
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {source}")
    prompt = annotate_carry_arc(image, transform, carry_yds, origin_local=origin_local)
    prompt_name = f"strategy_carry_arc_{carry_key:04d}_prompt_v0.png"
    cv2.imwrite(str(capture / prompt_name), prompt)
    semantic, provider_meta = call_provider_chain(capture / prompt_name, carry_yds=carry_yds,
                                                  provider=provider, fallback_provider=fallback_provider)
    validated = [
        validate_span(row, carry_yds=carry_yds, transform=transform,
                      image_width=image.shape[1], image_height=image.shape[0], origin_local=origin_local)
        for row in semantic.get("spans") or []
    ]
    accepted = [row for row in validated if row.get("accepted")]
    overlay = draw_result_overlay(image, transform, carry_yds, validated, origin_local=origin_local)
    overlay_name = f"strategy_carry_arc_{carry_key:04d}_overlay_v0.png"
    cv2.imwrite(str(capture / overlay_name), overlay)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": geometry.get("identity") or {"capture_id": capture.name},
        "carry_yds": float(carry_yds),
        "origin_local_yards": {"lateral": origin_local[0], "forward": origin_local[1]},
        "visual_truth": {"source_image": source.name},
        "prompt_artifact": prompt_name,
        "overlay_artifact": overlay_name,
        "semantic_present": semantic.get("present"),
        "semantic_note": semantic.get("note"),
        "spans": validated,
        "accepted_span_count": len(accepted),
        "provider": provider_meta,
        "qa": {
            "max_radial_residual_yds": MAX_RADIAL_RESIDUAL_YDS,
            "min_chord_width_yds": MIN_CHORD_WIDTH_YDS,
            "max_chord_width_yds": MAX_CHORD_WIDTH_YDS,
        },
        "interpretation": {
            "primitive": "club-carry landing arc intersected with current-hole fairway",
            "dogleg_safe": True,
            "not_course_reconstruction": True,
            "not_recommendation": True,
        },
        "strategy_authority": False,
        "recommendation": None,
    }
    write_json(output_path, payload)
    return payload


def extract_capture(capture: Path, *, carries_yds: Iterable[float] = DEFAULT_CARRIES,
                    provider: str = "luna", fallback_provider: str | None = "gemini",
                    force: bool = False) -> dict[str, Any]:
    requested = list(carries_yds)
    eligible = eligible_carries(capture, requested)
    meta = hole_metadata(capture)
    rows = []
    for carry in eligible:
        rows.append(extract_carry(capture, carry_yds=carry, provider=provider,
                                  fallback_provider=fallback_provider, force=force))
    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": {"capture_id": capture.name, **meta},
        "requested_carries_yds": requested,
        "eligible_carries_yds": eligible,
        "carry_results": [
            {
                "carry_yds": row["carry_yds"],
                "accepted_span_count": row["accepted_span_count"],
                "overlay_artifact": row["overlay_artifact"],
                "prompt_artifact": row["prompt_artifact"],
            }
            for row in rows
        ],
        "strategy_authority": False,
        "recommendation": None,
    }
    write_json(capture / "strategy_carry_arc_v0.json", payload)
    return payload


def capture_dirs(roots: Iterable[str]) -> list[Path]:
    rows = []
    for raw in roots:
        p = Path(raw).expanduser().resolve()
        if p.is_dir() and p.name.startswith("tee_capture_"):
            rows.append(p)
        elif p.is_dir():
            rows.extend(x for x in p.iterdir() if x.is_dir() and x.name.startswith("tee_capture_"))
    return sorted(set(rows), key=lambda p: p.stat().st_mtime)


def parse_carries(value: str | None) -> list[float]:
    if not value:
        return list(DEFAULT_CARRIES)
    return [float(part.strip()) for part in value.split(",") if part.strip()]


def main() -> int:
    p = argparse.ArgumentParser(description="Extract current-hole fairway intersections on club-carry arcs")
    p.add_argument("--capture-root", action="append", default=[])
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--carries", default="200,230,260")
    p.add_argument("--provider", default="luna")
    p.add_argument("--fallback-provider", default="gemini")
    p.add_argument("--latest", type=int, default=0)
    p.add_argument("--force", action="store_true")
    args = p.parse_args()

    captures = capture_dirs([*args.capture_root, *args.capture_dir])
    if args.latest > 0:
        captures = captures[-args.latest:]
    if not captures:
        print("No replayable tee capture folders found.")
        return 1

    carries = parse_carries(args.carries)
    failures = 0
    print("Looper Strategy Carry Arc v0")
    print("Carry-radius fairway intersections; dogleg-safe; no GSPro input; strategy authority OFF.")
    for capture in captures:
        try:
            payload = extract_capture(capture, carries_yds=carries, provider=args.provider,
                                      fallback_provider=(args.fallback_provider or None), force=args.force)
            ident = payload.get("identity") or {}
            results = payload.get("carry_results") or []
            summary = ", ".join(f"{int(r['carry_yds'])}y:{r['accepted_span_count']}" for r in results) or "SKIP"
            print(f"H{ident.get('hole_display','?')} carry arcs | {summary} | {capture.name}")
        except Exception as exc:
            failures += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("Strategy authority: OFF | Recommendation: NONE")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
