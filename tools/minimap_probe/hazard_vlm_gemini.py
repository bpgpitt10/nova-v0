#!/usr/bin/env python3
"""Gemini provider adapter for Looper VLM hazard shadow benchmarking.

Uses the Gemini GenerateContent REST API with the local GEMINI_API_KEY environment
variable. No SDK dependency is required. Gemini is asked for its native object-
detection representation: boxes in [ymin,xmin,ymax,xmax] coordinates on a 0-1000
scale plus optional segmentation polygons. The adapter converts boxes into Looper's
provider-neutral [x1,y1,x2,y2] 0-1 contract before local refinement.

Everything here is diagnostic-only. No result can influence strategy or GSPro.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import time
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

import cv2
import numpy as np

import hazard_vlm_contract
import hazard_vlm_refine
import hazard_vlm_shadow

API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "gemini-3.7-flash"

NATIVE_SYSTEM = """You analyze a golf-simulator minimap for Looper.
Identify only hazards that belong to the CURRENT HOLE, whose playable route runs
from the ball/player marker toward the pin/flag marker.

Classes:
- bunker: rendered sand bunker that is part of the current hole
- water: visible water surface that is part of the current hole
- uncertain: a region that may be bunker/water but is not reliable enough to classify

Ignore and DO NOT label buildings, roofs, houses, tennis courts, paths/cart paths,
roads, trees, shadows, UI text, yardage labels, icons, player marker, pin marker,
white out-of-bounds/boundary lines, red penalty-boundary lines, or obvious hazards
belonging only to adjacent holes.

Prefer precision over recall. If there is no water, return an empty water list.
Return only JSON matching the supplied schema."""

NATIVE_USER = """Analyze this tee minimap for CURRENT-HOLE bunkers and visible water.
For every object return:
- id
- confidence from 0 to 1
- box_2d as [ymin, xmin, ymax, xmax] normalized to integer coordinates 0-1000
- mask as a polygon of [x,y] points normalized to 0-1000; use an empty list only if
  a reliable polygon cannot be produced
- note, or null
Return separate bunkers, water, and uncertain arrays. Do not infer invisible hazards."""


def _slug(model: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in model)


def _mime(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed in {"image/png", "image/jpeg", "image/webp"}:
        return guessed
    return "image/png" if path.suffix.lower() == ".png" else "image/jpeg"


def _gemini_native_schema() -> dict[str, Any]:
    item = {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "confidence": {"type": "number"},
            "box_2d": {
                "type": "array",
                "items": {"type": "integer"},
                "minItems": 4,
                "maxItems": 4,
            },
            "mask": {
                "type": "array",
                "items": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "minItems": 2,
                    "maxItems": 2,
                },
            },
            "note": {"type": "string", "nullable": True},
        },
        "required": ["id", "confidence", "box_2d", "mask"],
    }
    return {
        "type": "object",
        "properties": {
            "bunkers": {"type": "array", "items": item},
            "water": {"type": "array", "items": item},
            "uncertain": {"type": "array", "items": item},
        },
        "required": ["bunkers", "water", "uncertain"],
    }


def _thinking_config(model: str, thinking_level: str | None) -> dict[str, Any] | None:
    if not thinking_level:
        return None
    if model.startswith("gemini-2.5"):
        return {"thinkingBudget": 0}
    return {"thinkingLevel": thinking_level}


def _extract_json(api_payload: dict[str, Any]) -> dict[str, Any]:
    candidates = api_payload.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {api_payload}")
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    texts = [
        str(part.get("text"))
        for part in parts
        if part.get("text") is not None and not part.get("thought")
    ]
    if not texts:
        raise RuntimeError(f"Gemini returned no non-thought text: {api_payload}")
    text = "\n".join(texts).strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
        if text.lower().startswith("json"):
            text = text[4:].lstrip()
    try:
        return json.loads(text)
    except Exception as exc:
        raise RuntimeError(f"Gemini response was not valid JSON: {text[:1200]}") from exc


def _native_box_to_looper(value: Any) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError(f"Gemini box_2d must have four values: {value!r}")
    ymin, xmin, ymax, xmax = [float(v) for v in value]
    vals = [ymin, xmin, ymax, xmax]
    if any(v < 0 or v > 1000 for v in vals):
        raise ValueError(f"Gemini box_2d outside 0-1000: {value!r}")
    if ymax <= ymin or xmax <= xmin:
        raise ValueError(f"Gemini box_2d has non-positive area: {value!r}")
    return [xmin / 1000.0, ymin / 1000.0, xmax / 1000.0, ymax / 1000.0]


def _native_to_contract(native: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "schema_version": hazard_vlm_contract.SCHEMA_VERSION,
        "bunkers": [],
        "water": [],
        "uncertain": [],
    }
    for field in ("bunkers", "water", "uncertain"):
        raw = native.get(field)
        if not isinstance(raw, list):
            raise ValueError(f"Gemini {field} must be a list")
        for index, item in enumerate(raw, 1):
            if not isinstance(item, dict):
                raise ValueError(f"Gemini {field}[{index}] must be an object")
            result[field].append({
                "id": str(item.get("id") or f"{field}-{index}"),
                "confidence": float(item.get("confidence", 0.0)),
                "bbox_norm": _native_box_to_looper(item.get("box_2d")),
                "note": item.get("note"),
            })
    hazard_vlm_contract.parse_response(result)
    return result


def _native_overlay(image: np.ndarray, native: dict[str, Any]) -> np.ndarray:
    canvas = image.copy()
    h, w = canvas.shape[:2]
    for field, prefix in (("bunkers", "B"), ("water", "W"), ("uncertain", "U")):
        for index, item in enumerate(native.get(field) or [], 1):
            try:
                ymin, xmin, ymax, xmax = [float(v) for v in item.get("box_2d")]
                x1, y1 = round(xmin / 1000.0 * w), round(ymin / 1000.0 * h)
                x2, y2 = round(xmax / 1000.0 * w), round(ymax / 1000.0 * h)
                cv2.rectangle(canvas, (x1, y1), (x2, y2), (255, 255, 255), 1)
                mask = item.get("mask") or []
                pts = []
                for point in mask:
                    if isinstance(point, list) and len(point) == 2:
                        px = round(float(point[0]) / 1000.0 * w)
                        py = round(float(point[1]) / 1000.0 * h)
                        pts.append([px, py])
                if len(pts) >= 3:
                    cv2.polylines(
                        canvas,
                        [np.array(pts, dtype=np.int32).reshape((-1, 1, 2))],
                        True,
                        (255, 255, 255),
                        2,
                        cv2.LINE_AA,
                    )
                label = f"{prefix}{index} {float(item.get('confidence', 0.0)):.2f}"
                cv2.putText(
                    canvas,
                    label,
                    (max(2, x1), max(14, y1 - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.38,
                    (255, 255, 255),
                    1,
                    cv2.LINE_AA,
                )
            except Exception:
                continue
    return canvas


def call_gemini(
    *,
    image_path: str | Path,
    model: str = DEFAULT_MODEL,
    api_key: str | None = None,
    thinking_level: str | None = None,
    timeout_seconds: float = 90.0,
    retries: int = 3,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    image_path = Path(image_path)
    key = api_key or os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError(
            "GEMINI_API_KEY is not available in this process. "
            "Set it in Windows and reopen PowerShell."
        )

    if thinking_level is None:
        thinking_level = (
            "minimal"
            if "flash-lite" in model and model.startswith("gemini-3")
            else "low"
        )

    image_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    generation_config: dict[str, Any] = {
        "responseMimeType": "application/json",
        "responseSchema": _gemini_native_schema(),
        "maxOutputTokens": 4096,
    }
    thinking = _thinking_config(model, thinking_level)
    if thinking:
        generation_config["thinkingConfig"] = thinking

    body = {
        "systemInstruction": {"parts": [{"text": NATIVE_SYSTEM}]},
        "contents": [{
            "role": "user",
            "parts": [
                {
                    "inlineData": {
                        "mimeType": _mime(image_path),
                        "data": image_b64,
                    }
                },
                {"text": NATIVE_USER},
            ],
        }],
        "generationConfig": generation_config,
    }

    started = time.perf_counter()
    last_error: Exception | None = None
    for attempt in range(max(1, int(retries))):
        req = urlrequest.Request(
            f"{API_ROOT}/{model}:generateContent",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": key,
            },
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=float(timeout_seconds)) as resp:
                api_payload = json.loads(resp.read().decode("utf-8"))
            latency = time.perf_counter() - started
            native = _extract_json(api_payload)
            result = _native_to_contract(native)
            hazards = hazard_vlm_contract.parse_response(result)
            meta = {
                "provider": "google-gemini",
                "model": model,
                "thinking_level": thinking_level,
                "latency_seconds": latency,
                "usage_metadata": api_payload.get("usageMetadata") or {},
                "hazard_counts": {
                    "bunker": sum(1 for x in hazards if x.hazard_class == "bunker"),
                    "water": sum(1 for x in hazards if x.hazard_class == "water"),
                    "uncertain": sum(1 for x in hazards if x.hazard_class == "uncertain"),
                },
            }
            return result, meta, native
        except urlerror.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", errors="replace")
            except Exception:
                detail = str(exc)
            last_error = RuntimeError(f"Gemini HTTP {exc.code}: {detail[:1600]}")
            if exc.code not in {429, 500, 502, 503, 504} or attempt + 1 >= retries:
                raise last_error
        except urlerror.URLError as exc:
            last_error = RuntimeError(f"Gemini network error: {exc}")
            if attempt + 1 >= retries:
                raise last_error
        time.sleep(min(8.0, 1.5 * (2 ** attempt)))

    raise last_error or RuntimeError("Gemini call failed")


def analyze_capture(
    capture_dir: str | Path,
    *,
    model: str = DEFAULT_MODEL,
    thinking_level: str | None = None,
    timeout_seconds: float = 90.0,
) -> dict[str, Any]:
    capture = Path(capture_dir)
    image_path = hazard_vlm_shadow._resolve_image(capture)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {image_path}")
    h, w = image.shape[:2]

    request_path = capture / "hazard_vlm_request_v0.json"
    hazard_vlm_contract.write_request(
        request_path,
        source_image=image_path.name,
        width=w,
        height=h,
    )

    response, meta, native = call_gemini(
        image_path=image_path,
        model=model,
        thinking_level=thinking_level,
        timeout_seconds=timeout_seconds,
    )
    slug = _slug(model)
    native_path = capture / f"hazard_vlm_provider_raw_{slug}_v0.json"
    native_path.write_text(json.dumps(native, indent=2), encoding="utf-8")

    response_path = capture / f"hazard_vlm_response_{slug}_v0.json"
    response_path.write_text(json.dumps(response, indent=2), encoding="utf-8")

    native_overlay_path = capture / f"hazard_vlm_native_overlay_{slug}_v0.png"
    cv2.imwrite(str(native_overlay_path), _native_overlay(image, native))

    hazards = hazard_vlm_contract.parse_response(response)
    _model_payload, geom = hazard_vlm_shadow._geometry(capture)
    if geom:
        ball, pin, scale = geom
    else:
        ball = pin = scale = None
    refined = hazard_vlm_refine.refine_all(
        image,
        hazards,
        ball_xy=ball,
        pin_xy=pin,
        yards_per_pixel=scale,
    )
    overlay_path = capture / f"hazard_vlm_overlay_{slug}_v0.png"
    cv2.imwrite(str(overlay_path), hazard_vlm_refine.draw_overlay(image, refined))

    payload = {
        "schema_version": "looper-hazard-vlm-gemini-v0",
        "strategy_authority": False,
        "created_epoch": time.time(),
        "source_image": image_path.name,
        "request_artifact": request_path.name,
        "provider_raw_artifact": native_path.name,
        "response_artifact": response_path.name,
        "native_overlay_artifact": native_overlay_path.name,
        "cv_refined_overlay_artifact": overlay_path.name,
        **meta,
        "objects": [item.to_dict() for item in refined],
    }
    result_path = capture / f"hazard_vlm_gemini_{slug}_v0.json"
    payload["result_artifact"] = result_path.name
    result_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def parse_args():
    p = argparse.ArgumentParser(
        description="Run Gemini VLM hazard localization on one tee capture"
    )
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--thinking-level")
    p.add_argument("--timeout-seconds", type=float, default=90.0)
    p.add_argument("--json", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    try:
        payload = analyze_capture(
            args.capture_dir,
            model=args.model,
            thinking_level=args.thinking_level,
            timeout_seconds=args.timeout_seconds,
        )
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            counts = payload["hazard_counts"]
            usage = payload.get("usage_metadata") or {}
            print(
                f"{payload['model']} | "
                f"bunkers={counts['bunker']} water={counts['water']} "
                f"uncertain={counts['uncertain']} | "
                f"{payload['latency_seconds']:.2f}s | "
                f"tokens={usage.get('totalTokenCount', '?')} | "
                "strategy authority=OFF"
            )
            print(
                f"Native overlay: {Path(args.capture_dir) / payload['native_overlay_artifact']}"
            )
            print(
                f"CV-refined overlay: "
                f"{Path(args.capture_dir) / payload['cv_refined_overlay_artifact']}"
            )
        return 0
    except Exception as exc:
        print(f"Gemini hazard VLM error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
