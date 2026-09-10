#!/usr/bin/env python3
"""Provider-neutral VLM contract for Looper tee-minimap hazard semantics.

The VLM's job is semantic localization only: identify current-hole bunker/water
regions and uncertain hazard-looking regions. Exact geometry is refined locally
afterward. Nothing in this module grants strategy authority.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
import json
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "looper-hazard-vlm-v0"
ALLOWED_CLASSES = {"bunker", "water", "uncertain"}

SYSTEM_INSTRUCTION = """You analyze a golf-simulator minimap for Looper.
Identify only hazards that belong to the CURRENT HOLE, whose playable route runs
from the ball/player marker toward the pin/flag marker.

Classes:
- bunker: rendered sand bunker that is part of the current hole
- water: visible water surface that is part of the current hole
- uncertain: a region that may be bunker/water but is not reliable enough to classify

Ignore and DO NOT label:
- buildings, roofs, houses, tennis courts, paths/cart paths, roads, trees, shadows
- UI text, yardage labels, icons, player marker, pin marker
- white out-of-bounds/boundary lines
- red penalty-boundary lines (Looper detects these separately)
- obvious hazards belonging only to adjacent holes

Return only structured JSON matching the supplied schema. Use normalized image
coordinates [0,1]. Boxes must tightly enclose the visible hazard region. If there
is no water, return an empty water list rather than inventing one. Prefer
precision over recall; put ambiguous regions in uncertain."""
USER_INSTRUCTION = """Analyze this tee minimap. Return current-hole bunker and water
regions only, plus uncertain regions. Do not infer hazards that are not visibly
present. Coordinates are x1,y1,x2,y2 normalized to image width/height."""


@dataclass(frozen=True)
class VlmHazard:
    hazard_id: str
    hazard_class: str
    confidence: float
    bbox_norm: tuple[float, float, float, float]
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out = asdict(self)
        out["bbox_norm"] = list(self.bbox_norm)
        return out


def response_schema() -> dict[str, Any]:
    item = {
        "type": "object",
        "additionalProperties": False,
        "required": ["id", "confidence", "bbox_norm"],
        "properties": {
            "id": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "bbox_norm": {
                "type": "array",
                "minItems": 4,
                "maxItems": 4,
                "items": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "note": {"type": ["string", "null"]},
        },
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["schema_version", "bunkers", "water", "uncertain"],
        "properties": {
            "schema_version": {"type": "string", "const": SCHEMA_VERSION},
            "bunkers": {"type": "array", "items": item},
            "water": {"type": "array", "items": item},
            "uncertain": {"type": "array", "items": item},
        },
    }


def build_request(*, source_image: str, width: int, height: int) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "task": "current-hole-hazard-semantic-localization",
        "strategy_authority": False,
        "source_image": source_image,
        "image_width": int(width),
        "image_height": int(height),
        "system_instruction": SYSTEM_INSTRUCTION,
        "user_instruction": USER_INSTRUCTION,
        "response_schema": response_schema(),
        "coordinate_contract": {
            "space": "normalized-image",
            "order": ["x1", "y1", "x2", "y2"],
            "range": [0.0, 1.0],
            "origin": "top-left",
        },
    }


def write_request(path: str | Path, *, source_image: str, width: int, height: int) -> dict[str, Any]:
    payload = build_request(source_image=source_image, width=width, height=height)
    Path(path).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def _box(value: Any) -> tuple[float, float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("bbox_norm must contain exactly four values")
    vals = tuple(float(x) for x in value)
    if any(x < 0.0 or x > 1.0 for x in vals):
        raise ValueError(f"bbox_norm outside [0,1]: {vals}")
    x1, y1, x2, y2 = vals
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"bbox_norm has non-positive area: {vals}")
    if (x2 - x1) * (y2 - y1) > 0.45:
        raise ValueError(f"bbox_norm implausibly covers most of minimap: {vals}")
    return vals


def _items(payload: dict[str, Any], field: str, hazard_class: str) -> list[VlmHazard]:
    raw = payload.get(field)
    if not isinstance(raw, list):
        raise ValueError(f"{field} must be a list")
    result: list[VlmHazard] = []
    for index, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise ValueError(f"{field}[{index}] must be an object")
        confidence = float(item.get("confidence"))
        if not (0.0 <= confidence <= 1.0):
            raise ValueError(f"{field}[{index}] confidence outside [0,1]")
        result.append(VlmHazard(
            hazard_id=str(item.get("id") or f"{hazard_class}-{index}"),
            hazard_class=hazard_class,
            confidence=confidence,
            bbox_norm=_box(item.get("bbox_norm")),
            note=(str(item["note"]) if item.get("note") is not None else None),
        ))
    return result


def parse_response(payload_or_path: dict[str, Any] | str | Path) -> list[VlmHazard]:
    if isinstance(payload_or_path, (str, Path)):
        payload = json.loads(Path(payload_or_path).read_text(encoding="utf-8"))
    else:
        payload = payload_or_path
    if not isinstance(payload, dict):
        raise ValueError("VLM response must be a JSON object")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported VLM response schema {payload.get('schema_version')!r}; "
            f"expected {SCHEMA_VERSION!r}"
        )
    hazards = []
    hazards.extend(_items(payload, "bunkers", "bunker"))
    hazards.extend(_items(payload, "water", "water"))
    hazards.extend(_items(payload, "uncertain", "uncertain"))
    ids = [item.hazard_id for item in hazards]
    if len(ids) != len(set(ids)):
        raise ValueError("VLM hazard ids must be unique")
    return hazards


def bbox_px(hazard: VlmHazard, width: int, height: int) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = hazard.bbox_norm
    return (
        max(0, min(width - 1, round(x1 * width))),
        max(0, min(height - 1, round(y1 * height))),
        max(1, min(width, round(x2 * width))),
        max(1, min(height, round(y2 * height))),
    )
