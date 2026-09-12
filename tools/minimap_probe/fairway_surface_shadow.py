#!/usr/bin/env python3
"""Shadow-only fairway extraction from saved GSPro tee minimaps.

The semantic model decides whether a visible fairway exists and localizes it with one
broad box. SAM2 supplies the pixel edge.  Fairway geometry is deliberately separate
from HazardGeometry because fairway is a playable surface, not a hazard.

This is offline evidence tooling: it never actuates GSPro and never grants strategy
authority.  A reviewed/promoted surface contract can be designed after field replay.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
from pathlib import Path
import time
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

import cv2
import numpy as np

import hazard_prompt_segment as hps

SCHEMA_VERSION = "looper-fairway-surface-shadow-v0"
DEFAULT_MODEL = "gemini-3.1-flash-lite"
STRATEGY_AUTHORITY = False

SYSTEM = """You analyze a GSPro golf-simulator TEE minimap for Looper.
Your only job is to identify the FAIRWAY belonging to the CURRENT HOLE.

Fairway means the visibly shorter-mown landing/approach surface between the tee area
and the target green. Exclude the putting green itself, tee boxes, rough, trees,
bunkers/sand, water, cart paths, roads, buildings, neighboring-hole fairways, UI,
markers, red penalty lines, and white OB lines.

Return present=false when this hole has no visually distinct fairway (common on many
par 3s), or when you cannot identify it reliably. Prefer precision over guessing.
When present=true, return ONE box covering the whole visible current-hole fairway,
even for a dogleg. A downstream segmenter will trace the exact edge.
Return only JSON matching the supplied schema."""

USER = """Identify the current-hole fairway. box_2d is [ymin,xmin,ymax,xmax] in
integer 0-1000 image coordinates. Do not include a polygon or mask."""


def semantic_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "present": {"type": "boolean"},
            "confidence": {"type": "number"},
            "box_2d": {"type": ["array", "null"], "items": {"type": "integer"}},
            "note": {"type": ["string", "null"]},
        },
        "required": ["present", "confidence", "box_2d", "note"],
    }


def _mime(path: Path) -> str:
    return "image/png" if path.suffix.lower() == ".png" else "image/jpeg"


def _extract_json(payload: dict[str, Any]) -> dict[str, Any]:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    text = "".join(str(p.get("text") or "") for p in parts).strip()
    if not text:
        raise RuntimeError("Gemini returned no JSON text")
    return json.loads(text)


def call_semantic_locator(image_path: Path, *, model: str, api_key: str | None = None,
                          timeout_seconds: float = 90.0, retries: int = 3) -> tuple[dict[str, Any], dict[str, Any]]:
    key = api_key or os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not available in this process")
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": _mime(image_path), "data": base64.b64encode(image_path.read_bytes()).decode("ascii")}},
            {"text": USER},
        ]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": semantic_schema(),
            "maxOutputTokens": 512,
            "thinkingConfig": {"thinkingLevel": "minimal"},
        },
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urlrequest.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
            result = _extract_json(payload)
            confidence = float(result.get("confidence", 0.0))
            if not 0.0 <= confidence <= 1.0:
                raise ValueError("fairway semantic confidence outside [0,1]")
            box = result.get("box_2d")
            if result.get("present"):
                if not isinstance(box, list) or len(box) != 4:
                    raise ValueError("present fairway requires four-value box_2d")
                vals = [int(v) for v in box]
                if any(v < 0 or v > 1000 for v in vals) or vals[2] <= vals[0] or vals[3] <= vals[1]:
                    raise ValueError("invalid fairway box_2d")
                result["box_2d"] = vals
            else:
                result["box_2d"] = None
            meta = {
                "provider": "google-gemini", "model": model,
                "latency_seconds": time.perf_counter() - started,
                "usage_metadata": payload.get("usageMetadata") or {},
            }
            return result, meta
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last = RuntimeError(f"Gemini HTTP {exc.code}: {detail[:1200]}")
            if exc.code not in {429, 500, 502, 503, 504} or attempt + 1 >= retries:
                raise last
        except urlerror.URLError as exc:
            last = RuntimeError(f"Gemini network error: {exc}")
            if attempt + 1 >= retries:
                raise last
        time.sleep(min(8.0, 1.5 * (2 ** attempt)))
    raise last or RuntimeError("fairway semantic localization failed")


def box_px(box_1000: list[int], width: int, height: int, pad_fraction: float = 0.04) -> tuple[int, int, int, int]:
    y1, x1, y2, x2 = box_1000
    ax1, ay1 = x1 / 1000.0 * width, y1 / 1000.0 * height
    ax2, ay2 = x2 / 1000.0 * width, y2 / 1000.0 * height
    dx = max(2.0, (ax2 - ax1) * pad_fraction)
    dy = max(2.0, (ay2 - ay1) * pad_fraction)
    return (max(0, int(round(ax1 - dx))), max(0, int(round(ay1 - dy))),
            min(width, int(round(ax2 + dx))), min(height, int(round(ay2 + dy))))


def _component_near_box(mask: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    binary = (np.asarray(mask) > 0).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    if count <= 1:
        return binary.astype(bool)
    x1, y1, x2, y2 = box
    best, best_score = None, -1.0
    for label in range(1, count):
        comp = labels == label
        area = int(stats[label, cv2.CC_STAT_AREA])
        inside = int(comp[y1:y2, x1:x2].sum())
        if area <= 0 or inside <= 0:
            continue
        # Fairways are intentionally large/elongated; unlike hazard QA, reward area
        # provided the component actually intersects the semantic box.
        score = inside + 0.35 * area
        if score > best_score:
            best, best_score = label, score
    return (labels == best) if best is not None else np.zeros_like(binary, dtype=bool)


def _line_samples(a: tuple[float, float], b: tuple[float, float], n: int = 80) -> np.ndarray:
    xs = np.linspace(a[0], b[0], n)
    ys = np.linspace(a[1], b[1], n)
    return np.stack([xs, ys], axis=1)


def topology_metrics(mask: np.ndarray, tee: tuple[float, float] | None, pin: tuple[float, float] | None) -> dict[str, Any]:
    h, w = mask.shape[:2]
    area = int(mask.sum())
    out: dict[str, Any] = {
        "mask_area_px": area,
        "image_fraction": area / max(1, h * w),
        "touches_image_edge": False,
        "tee_pin_centerline_fraction": None,
    }
    if area:
        ys, xs = np.where(mask)
        out["touches_image_edge"] = bool(xs.min() == 0 or ys.min() == 0 or xs.max() == w - 1 or ys.max() == h - 1)
    if tee and pin:
        pts = _line_samples(tee, pin)
        xi = np.clip(np.rint(pts[:, 0]).astype(int), 0, w - 1)
        yi = np.clip(np.rint(pts[:, 1]).astype(int), 0, h - 1)
        out["tee_pin_centerline_fraction"] = float(mask[yi, xi].mean())
    return out


def candidate_quality(mask: np.ndarray, box: tuple[int, int, int, int], model_score: float | None,
                      tee: tuple[float, float] | None, pin: tuple[float, float] | None) -> tuple[float, list[str], dict[str, Any]]:
    h, w = mask.shape[:2]
    x1, y1, x2, y2 = box
    area = int(mask.sum())
    box_area = max(1, (x2 - x1) * (y2 - y1))
    inside = int(mask[y1:y2, x1:x2].sum())
    topo = topology_metrics(mask, tee, pin)
    reasons: list[str] = []
    frac = topo["image_fraction"]
    if area < max(30, int(h * w * 0.002)):
        reasons.append("too-small-for-fairway")
    if frac > 0.72:
        reasons.append("implausibly-large-image-fraction")
    if inside / max(1, area) < 0.10:
        reasons.append("little-overlap-with-semantic-box")
    if area / box_area < 0.03:
        reasons.append("far-smaller-than-semantic-box")
    center = topo.get("tee_pin_centerline_fraction")
    if center is not None and center < 0.06:
        reasons.append("little-tee-pin-route-support")
    score = float(model_score) if model_score is not None and math.isfinite(float(model_score)) else 0.0
    score += 0.30 * min(1.0, inside / max(1, area))
    score += 0.20 * min(1.0, area / box_area)
    if center is not None:
        score += 0.25 * min(1.0, center * 2.0)
    score -= 0.30 * len(reasons)
    return score, reasons, topo


def mask_to_polygon(mask: np.ndarray) -> list[list[int]]:
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    epsilon = max(0.8, cv2.arcLength(contour, True) * 0.0025)
    approx = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
    return [[int(x), int(y)] for x, y in approx[:2500]]


def _xy(d: Any) -> tuple[float, float] | None:
    if isinstance(d, dict) and d.get("x") is not None and d.get("y") is not None:
        return float(d["x"]), float(d["y"])
    return None


def find_source_image(capture: Path) -> Path:
    for name in ("tee_hazard_safe_minimap.png", "tee_canonical_minimap.png", "tee_initial_minimap.png", "watcher_prelaunch_minimap.png"):
        p = capture / name
        if p.is_file():
            return p
    # Heatmap image is intentionally last because colored slope fill can confuse
    # semantic/segmentation models.
    p = capture / "tee_heatmap_minimap.png"
    if p.is_file():
        return p
    raise FileNotFoundError(f"No saved tee minimap found in {capture}")


def identity(capture: Path) -> dict[str, Any]:
    out: dict[str, Any] = {"capture_id": capture.name}
    for name in ("capture_context.json", "hazard_map_shadow_v0.json"):
        p = capture / name
        if not p.is_file():
            continue
        try:
            raw = json.loads(p.read_text(encoding="utf-8-sig"))
            nested = raw.get("identity") if isinstance(raw.get("identity"), dict) else {}
            out.update({k: v for k, v in {
                "course_name": raw.get("course_name") or nested.get("course_name"),
                "course_key": raw.get("course_key") or nested.get("course_key"),
                "round_id": raw.get("round_id") or nested.get("round_id"),
                "hole_display": raw.get("hole_number") or nested.get("hole_display") or nested.get("hole_number"),
                "par": raw.get("par") or nested.get("par"),
            }.items() if v is not None})
        except Exception:
            pass
    return out


def extract_capture(capture: Path, *, model: str = DEFAULT_MODEL, sam_model: str = hps.DEFAULT_SAM2_MODEL,
                    device: str = "auto", force: bool = False) -> dict[str, Any]:
    output = capture / "fairway_surface_shadow_v0.json"
    if output.is_file() and not force:
        return json.loads(output.read_text(encoding="utf-8-sig"))
    source = find_source_image(capture)
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {source}")
    h, w = image.shape[:2]
    ident = identity(capture)
    semantic, semantic_meta = call_semantic_locator(source, model=model)
    base_payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "identity": ident,
        "source_image": source.name,
        "strategy_authority": False,
        "promotion_decision": "none",
        "semantic": {**semantic, **semantic_meta},
        "fairway_present": bool(semantic.get("present")),
        "fairway": None,
        "warnings": [],
    }
    if not semantic.get("present"):
        if ident.get("par") not in {3, "3"}:
            base_payload["warnings"].append("semantic model reported no visible fairway on a non-par-3 hole")
        output.write_text(json.dumps(base_payload, indent=2), encoding="utf-8")
        return base_payload

    box = box_px(semantic["box_2d"], w, h)
    hole_model_path = capture / "hole_model.json"
    tee = pin = None
    if hole_model_path.is_file():
        try:
            hm = json.loads(hole_model_path.read_text(encoding="utf-8-sig"))
            mm = hm.get("minimap") or {}
            tee, pin = _xy(mm.get("ball_pixel")), _xy(mm.get("pin_pixel"))
        except Exception:
            pass

    backend = hps.Sam2TransformersBackend(model_id=sam_model, device=device)
    predictions = backend.predict(cv2.cvtColor(image, cv2.COLOR_BGR2RGB), [list(box)])[0]
    candidates = []
    best_mask = None
    best_score = -1e9
    for i, pred in enumerate(predictions):
        mask = _component_near_box(pred.mask, box)
        score, reasons, topo = candidate_quality(mask, box, pred.model_score, tee, pin)
        candidates.append({"candidate": i, "model_score": pred.model_score, "quality_score": score,
                           "rejection_reasons": reasons, "topology": topo})
        if not reasons and score > best_score:
            best_score, best_mask = score, mask
    if best_mask is None:
        base_payload["warnings"].append("SAM2 produced no candidate passing fairway QA")
        base_payload["segmentation_candidates"] = candidates
        output.write_text(json.dumps(base_payload, indent=2), encoding="utf-8")
        return base_payload

    # Remove the known target-green heatmap mask conservatively so the fairway
    # polygon cannot absorb the putting green merely because both are turf.
    green_removed = False
    green_path = capture / "tee_target_green_mask.png"
    if green_path.is_file():
        gm = cv2.imread(str(green_path), cv2.IMREAD_GRAYSCALE)
        if gm is not None and gm.shape == best_mask.shape:
            best_mask = best_mask & ~(gm > 0)
            green_removed = True

    # Re-select the largest fairway component after green subtraction.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(best_mask.astype(np.uint8), 8)
    if count > 1:
        label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        best_mask = labels == label
    polygon = mask_to_polygon(best_mask)
    if len(polygon) < 3:
        base_payload["warnings"].append("accepted fairway mask did not produce a valid polygon")
    mask_name = "fairway_surface_shadow_mask_v0.png"
    cv2.imwrite(str(capture / mask_name), best_mask.astype(np.uint8) * 255)
    overlay = image.copy()
    contours, _ = cv2.findContours(best_mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(overlay, contours, -1, (80, 230, 120), 2)
    overlay_name = "fairway_surface_shadow_overlay_v0.png"
    cv2.imwrite(str(capture / overlay_name), overlay)
    topo = topology_metrics(best_mask, tee, pin)
    base_payload["fairway_present"] = bool(polygon)
    base_payload["segmentation_candidates"] = candidates
    base_payload["fairway"] = {
        "class": "fairway",
        "mask_artifact": mask_name,
        "overlay_artifact": overlay_name,
        "polygon_minimap_pixel": polygon,
        "polygon_minimap_normalized": [[x / w, y / h] for x, y in polygon],
        "semantic_confidence": float(semantic.get("confidence", 0.0)),
        "segmentation_quality_score": best_score,
        "topology": topo,
        "green_mask_subtracted": green_removed,
        "coordinate_authority": "shadow-semantic-plus-sam2",
        "strategy_authority": False,
    }
    output.write_text(json.dumps(base_payload, indent=2), encoding="utf-8")
    return base_payload


def capture_dirs(roots: list[str]) -> list[Path]:
    rows: list[Path] = []
    for raw in roots:
        p = Path(raw).expanduser().resolve()
        if p.is_dir() and p.name.startswith("tee_capture_"):
            rows.append(p)
        elif p.is_dir():
            rows.extend(x for x in p.glob("tee_capture_*") if x.is_dir())
    return sorted(set(rows), key=lambda p: p.stat().st_mtime)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Extract shadow fairway geometry from saved GSPro tee minimaps")
    p.add_argument("--capture-root", action="append", default=[])
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--sam-model", default=hps.DEFAULT_SAM2_MODEL)
    p.add_argument("--device", default="auto")
    p.add_argument("--latest", type=int, default=0, help="Only process N newest captures; 0 = all")
    p.add_argument("--force", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    captures = capture_dirs([*args.capture_root, *args.capture_dir])
    if args.latest > 0:
        captures = captures[-args.latest:]
    if not captures:
        print("No tee capture folders found.")
        return 1
    errors = 0
    for capture in captures:
        try:
            result = extract_capture(capture, model=args.model, sam_model=args.sam_model, device=args.device, force=args.force)
            ident = result.get("identity") or {}
            fw = result.get("fairway") or {}
            topo = fw.get("topology") or {}
            route = topo.get("tee_pin_centerline_fraction")
            route_text = "n/a" if route is None else f"{float(route):.0%}"
            print(f"H{ident.get('hole_display','?')} fairway={'YES' if result.get('fairway_present') else 'NO'} | route={route_text} | {capture.name}")
        except Exception as exc:
            errors += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("Strategy authority: OFF | Promotion: NONE")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
