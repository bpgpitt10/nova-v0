#!/usr/bin/env python3
"""Cheap Gemini semantic localization for downstream promptable segmentation.

This intentionally asks Gemini only for class + tight box. Exact geometry belongs to
SAM2/other promptable segmentation. Keeping the response small cuts token usage and
avoids treating Gemini polygons as authoritative geometry.
"""
from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

import hazard_vlm_contract
import hazard_vlm_gemini as base

SCHEMA_VERSION = "looper-hazard-gemini-boxes-v0"
DEFAULT_MODEL = "gemini-3.1-flash-lite"

SYSTEM = """You analyze a GSPro golf-simulator tee minimap for Looper.
Identify only visible hazards belonging to the CURRENT HOLE, following the playable
route from the player/ball marker toward the pin/flag marker.

Classes:
- bunker: visible sand bunker belonging to the current hole
- water: visible water surface belonging to the current hole
- uncertain: possibly bunker/water but not reliable enough to classify

DO NOT label buildings, roofs, houses, tennis courts, roads, cart paths, trees,
shadows, UI text, yardage labels, icons, the player marker, pin marker, white OB
lines, red penalty-boundary lines, or hazards clearly belonging only to adjacent
holes. A colored green heatmap/slope overlay around the pin is NOT water.

Prefer precision over recall. If there is no water, return an empty water list.
Return only JSON matching the supplied schema. Exact segmentation is done locally;
your job is semantic identification and a tight bounding box only."""

USER = """Find current-hole bunkers and visible water. Return id, confidence and
box_2d=[ymin,xmin,ymax,xmax] using integer 0-1000 image coordinates. Also return an
uncertain list for genuinely ambiguous regions. Do not return polygons or masks."""


def schema() -> dict[str, Any]:
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
        },
        "required": ["id", "confidence", "box_2d"],
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


def native_to_contract(native: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "schema_version": hazard_vlm_contract.SCHEMA_VERSION,
        "bunkers": [],
        "water": [],
        "uncertain": [],
    }
    for field in ("bunkers", "water", "uncertain"):
        rows = native.get(field)
        if not isinstance(rows, list):
            raise ValueError(f"Gemini {field} must be a list")
        for i, row in enumerate(rows, 1):
            if not isinstance(row, dict):
                raise ValueError(f"Gemini {field}[{i}] must be an object")
            out[field].append({
                "id": str(row.get("id") or f"{field}-{i}"),
                "confidence": float(row.get("confidence", 0.0)),
                "bbox_norm": base._native_box_to_looper(row.get("box_2d")),
                "note": None,
            })
    hazard_vlm_contract.parse_response(out)
    return out


def call_gemini_boxes(
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
        raise RuntimeError("GEMINI_API_KEY is not available in this process.")
    if thinking_level is None:
        thinking_level = "minimal" if "flash-lite" in model else "low"

    generation: dict[str, Any] = {
        "responseMimeType": "application/json",
        "responseSchema": schema(),
        "maxOutputTokens": 1536,
    }
    thinking = base._thinking_config(model, thinking_level)
    if thinking:
        generation["thinkingConfig"] = thinking

    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{
            "role": "user",
            "parts": [
                {"inlineData": {
                    "mimeType": base._mime(image_path),
                    "data": base64.b64encode(image_path.read_bytes()).decode("ascii"),
                }},
                {"text": USER},
            ],
        }],
        "generationConfig": generation,
    }

    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, int(retries))):
        req = urlrequest.Request(
            f"{base.API_ROOT}/{model}:generateContent",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=float(timeout_seconds)) as response:
                api_payload = json.loads(response.read().decode("utf-8"))
            native = base._extract_json(api_payload)
            contract = native_to_contract(native)
            hazards = hazard_vlm_contract.parse_response(contract)
            meta = {
                "schema_version": SCHEMA_VERSION,
                "provider": "google-gemini",
                "model": model,
                "thinking_level": thinking_level,
                "latency_seconds": time.perf_counter() - started,
                "usage_metadata": api_payload.get("usageMetadata") or {},
                "hazard_counts": {
                    "bunker": sum(x.hazard_class == "bunker" for x in hazards),
                    "water": sum(x.hazard_class == "water" for x in hazards),
                    "uncertain": sum(x.hazard_class == "uncertain" for x in hazards),
                },
                "geometry_contract": "semantic-box-only; exact mask delegated to local segmenter",
                "strategy_authority": False,
            }
            return contract, meta, native
        except urlerror.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", errors="replace")
            except Exception:
                detail = str(exc)
            last = RuntimeError(f"Gemini HTTP {exc.code}: {detail[:1600]}")
            if exc.code not in {429, 500, 502, 503, 504} or attempt + 1 >= retries:
                raise last
        except urlerror.URLError as exc:
            last = RuntimeError(f"Gemini network error: {exc}")
            if attempt + 1 >= retries:
                raise last
        time.sleep(min(8.0, 1.5 * (2 ** attempt)))
    raise last or RuntimeError("Gemini box localization failed")
