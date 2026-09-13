#!/usr/bin/env python3
"""Build a cheap, screenshot-derived visual profile for one GSPro course.

This profile is intentionally descriptive, not strategic. It uses only the existing
GSPro surface/physics vocabulary (fairway, rough, deep rough, bunker, green, water)
and records how those surfaces appear in this specific rendering. It must never
create geometry, invent a new lie class, or change gameplay penalties.

The profile is meant to be cached per course/version and reused by semantic vision
prompts. A cold course can learn from a handful of tee screenshots; popular courses
can later share a reviewed profile across users.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import re
from pathlib import Path
import time
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

import cv2
import numpy as np

import hazard_vlm_openai as openai_adapter
import strategy_carry_arc_v0 as arc0

SCHEMA_VERSION = "looper-course-visual-profile-v0"
DEFAULT_MODEL = "gpt-5.6-luna"
MAX_IMAGES = 8
RETRYABLE_HTTP = {408, 409, 429, 500, 502, 503, 504}

SYSTEM = """You are profiling the VISUAL RENDERING of one GSPro golf course for Looper.
You are shown several tee minimaps from the SAME course.

Your job is ONLY to describe how existing GSPro surface/physics categories appear in
these screenshots so later vision calls can recognize them more reliably.

Allowed surface labels are exactly:
- fairway
- rough
- deep_rough
- bunker
- green
- water

Important rules:
- Do NOT invent new gameplay/lie classes such as waste_area or native_grass.
- A huge waste-style sandy area may still visually represent GSPro BUNKER; describe
  its appearance under bunker rather than creating a new category.
- Wispy/native vegetation may visually correspond to ROUGH or DEEP_ROUGH. If these
  cannot be distinguished from screenshots alone, say observable=false rather than
  guessing.
- Do NOT infer gameplay penalty, lie penalty, spin penalty, or strategy severity.
- Do NOT output coordinates, polygons, boxes, hazards, or hole geometry.
- Describe recurring visual cues only when supported by the supplied screenshots.
- Neighboring-hole confusion cues are useful: describe how a later detector can avoid
  mistaking adjacent fairways/greens for the current hole.

This is a weak visual prior only. Future per-hole screenshot evidence always wins.
Return only structured JSON matching the supplied schema."""


def _surface_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "observable": {"type": "boolean"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "appearance": {"type": "string"},
            "distinguishing_cues": {"type": "array", "items": {"type": "string"}, "maxItems": 8},
            "common_confusions": {"type": "array", "items": {"type": "string"}, "maxItems": 6},
        },
        "required": ["observable", "confidence", "appearance", "distinguishing_cues", "common_confusions"],
        "additionalProperties": False,
    }


def schema() -> dict[str, Any]:
    surfaces = {name: _surface_schema() for name in ("fairway", "rough", "deep_rough", "bunker", "green", "water")}
    return {
        "type": "object",
        "properties": {
            "course_style_summary": {"type": "string"},
            "overall_confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "surfaces": {
                "type": "object",
                "properties": surfaces,
                "required": list(surfaces),
                "additionalProperties": False,
            },
            "current_hole_disambiguation_cues": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
            "rendering_warnings": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
        },
        "required": ["course_style_summary", "overall_confidence", "surfaces", "current_hole_disambiguation_cues", "rendering_warnings"],
        "additionalProperties": False,
    }


def _slug(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return text or "unknown-course"


def _identity(capture: Path) -> dict[str, Any]:
    out = {"capture_id": capture.name}
    for name in ("capture_context.json", "screenshot_strategy_geometry_v2.json", "hole_model.json"):
        path = capture / name
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        nested = raw.get("identity") if isinstance(raw.get("identity"), dict) else {}
        for key, value in {
            "course_name": raw.get("course_name") or nested.get("course_name"),
            "course_key": raw.get("course_key") or nested.get("course_key"),
            "hole_display": raw.get("hole_number") or nested.get("hole_display") or nested.get("hole_number"),
            "par": raw.get("par") or nested.get("par"),
        }.items():
            if value is not None and out.get(key) is None:
                out[key] = value
    return out


def representative_captures(captures: list[Path], max_images: int = MAX_IMAGES) -> list[Path]:
    if not captures:
        return []
    ordered = sorted(captures, key=lambda p: int(_identity(p).get("hole_display") or 999))
    count = min(len(ordered), max(1, int(max_images)))
    if count == len(ordered):
        return ordered
    indices = np.linspace(0, len(ordered) - 1, count).round().astype(int).tolist()
    seen = set()
    rows = []
    for idx in indices:
        if idx in seen:
            continue
        seen.add(idx)
        rows.append(ordered[idx])
    return rows


def build_contact_sheet(captures: list[Path], output_path: Path) -> list[dict[str, Any]]:
    panels = []
    evidence = []
    for capture in captures:
        source = arc0.find_source_image(capture)
        image = cv2.imread(str(source), cv2.IMREAD_COLOR)
        if image is None:
            continue
        ident = _identity(capture)
        width = 320
        height = max(1, int(round(image.shape[0] * width / image.shape[1])))
        body = cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA)
        header = np.zeros((42, width, 3), dtype=np.uint8)
        header[:] = (18, 24, 20)
        label = f"H{ident.get('hole_display','?')}  {ident.get('course_name') or ident.get('course_key') or ''}".strip()
        cv2.putText(header, label[:46], (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (245,245,245), 1, cv2.LINE_AA)
        panels.append(np.vstack([header, body]))
        evidence.append({"capture_id": capture.name, "hole_display": ident.get("hole_display"), "source_image": source.name})
    if not panels:
        raise RuntimeError("No readable tee minimaps for course visual profile")
    cols = min(4, len(panels))
    gap = 10
    cell_w = max(p.shape[1] for p in panels)
    cell_h = max(p.shape[0] for p in panels)
    rows = math.ceil(len(panels) / cols)
    sheet = np.zeros((rows * cell_h + (rows - 1) * gap, cols * cell_w + (cols - 1) * gap, 3), dtype=np.uint8)
    sheet[:] = (8, 12, 10)
    for i, panel in enumerate(panels):
        y = (i // cols) * (cell_h + gap)
        x = (i % cols) * (cell_w + gap)
        sheet[y:y+panel.shape[0], x:x+panel.shape[1]] = panel
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), sheet, [int(cv2.IMWRITE_JPEG_QUALITY), 92]):
        raise RuntimeError(f"Could not write {output_path}")
    return evidence


def normalize_profile(raw: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("course visual profile must be an object")
    confidence = float(raw.get("overall_confidence", 0.0))
    if not 0 <= confidence <= 1:
        raise ValueError("overall_confidence outside [0,1]")
    surfaces = raw.get("surfaces")
    if not isinstance(surfaces, dict):
        raise ValueError("surfaces must be an object")
    normalized_surfaces = {}
    for name in ("fairway", "rough", "deep_rough", "bunker", "green", "water"):
        row = surfaces.get(name)
        if not isinstance(row, dict):
            raise ValueError(f"missing surface profile {name}")
        conf = float(row.get("confidence", 0.0))
        if not 0 <= conf <= 1:
            raise ValueError(f"{name} confidence outside [0,1]")
        normalized_surfaces[name] = {
            "observable": bool(row.get("observable")),
            "confidence": conf,
            "appearance": str(row.get("appearance") or "").strip(),
            "distinguishing_cues": [str(x).strip() for x in (row.get("distinguishing_cues") or []) if str(x).strip()][:8],
            "common_confusions": [str(x).strip() for x in (row.get("common_confusions") or []) if str(x).strip()][:6],
        }
    return {
        "course_style_summary": str(raw.get("course_style_summary") or "").strip(),
        "overall_confidence": confidence,
        "surfaces": normalized_surfaces,
        "current_hole_disambiguation_cues": [str(x).strip() for x in (raw.get("current_hole_disambiguation_cues") or []) if str(x).strip()][:10],
        "rendering_warnings": [str(x).strip() for x in (raw.get("rendering_warnings") or []) if str(x).strip()][:10],
    }


def call_luna(image_path: Path, *, course_name: str, model: str = DEFAULT_MODEL, timeout_seconds: float = 75.0, retries: int = 3) -> tuple[dict[str, Any], dict[str, Any]]:
    import os
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not available")
    body = {
        "model": model,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": SYSTEM}]},
            {"role": "user", "content": [
                {"type": "input_image", "image_url": f"data:{openai_adapter._mime(image_path)};base64,{base64.b64encode(image_path.read_bytes()).decode('ascii')}", "detail": "original"},
                {"type": "input_text", "text": f"These are representative GSPro tee minimaps from {course_name}. Build only a visual-rendering profile using the allowed GSPro surface labels."},
            ]},
        ],
        "text": {"format": {"type": "json_schema", "name": "looper_course_visual_profile_v0", "strict": True, "schema": schema()}},
        "reasoning": {"effort": "none"},
        "max_output_tokens": 4096,
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urlrequest.Request(openai_adapter.API_URL, data=json.dumps(body).encode("utf-8"), headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
            raw = json.loads(openai_adapter._extract_output_text(payload))
            return normalize_profile(raw), {
                "provider": "openai-luna",
                "model": model,
                "latency_seconds": time.perf_counter() - started,
                "response_id": payload.get("id"),
                "usage_metadata": payload.get("usage") or {},
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
    raise last or RuntimeError("course visual profile Luna call failed")


def build(capture_root: Path, *, latest: int = 18, max_images: int = MAX_IMAGES, force: bool = False) -> Path:
    captures = arc0.capture_dirs([str(capture_root)])
    if latest > 0:
        captures = captures[-latest:]
    if not captures:
        raise RuntimeError("No tee captures found for course visual profile")
    identities = [_identity(c) for c in captures]
    course_name = next((str(i.get("course_name")) for i in identities if i.get("course_name")), None) or next((str(i.get("course_key")) for i in identities if i.get("course_key")), None) or "Unknown GSPro Course"
    course_key = next((str(i.get("course_key")) for i in identities if i.get("course_key")), None)
    profile_dir = capture_root / "course_profiles" / _slug(course_key or course_name)
    output_path = profile_dir / "course_visual_profile_v0.json"
    if output_path.is_file() and not force:
        return output_path
    selected = representative_captures(captures, max_images=max_images)
    sheet_path = profile_dir / "course_visual_profile_contact_sheet_v0.jpg"
    evidence = build_contact_sheet(selected, sheet_path)
    profile, provider = call_luna(sheet_path, course_name=course_name)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "course_identity": {"course_name": course_name, "course_key": course_key, "cache_key": _slug(course_key or course_name)},
        "evidence": {"capture_count": len(evidence), "captures": evidence, "contact_sheet": sheet_path.name},
        "profile": profile,
        "provider": provider,
        "policy": {
            "physics_taxonomy_fixed_to_gspro": True,
            "new_lie_classes_allowed": False,
            "geometry_authority": False,
            "gameplay_penalty_authority": False,
            "per_hole_visible_evidence_overrides_profile": True,
        },
        "strategy_authority": False,
    }
    profile_dir.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return output_path


def main() -> int:
    p = argparse.ArgumentParser(description="Build cached visual rendering profile for a GSPro course")
    p.add_argument("--capture-root", default="tools/minimap_probe/output")
    p.add_argument("--latest", type=int, default=18)
    p.add_argument("--max-images", type=int, default=MAX_IMAGES)
    p.add_argument("--force", action="store_true")
    args = p.parse_args()
    path = build(Path(args.capture_root).expanduser().resolve(), latest=args.latest, max_images=args.max_images, force=args.force)
    print(f"Course visual profile: {path}")
    print("Physics taxonomy: GSPro only | Geometry authority: OFF | Strategy authority: OFF")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
