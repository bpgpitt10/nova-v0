#!/usr/bin/env python3
"""Geometry Review v2: add shadow fairway geometry to the existing v1 review.

This is an offline/read-only extension of geometry_review_v1. It reuses the proven
Actual / Reconstruction / Overlay page and injects the fairway extracted by
fairway_surface_shadow_v0. When hole_spatial_model_v1 is available, the fairway is
projected through hole-local yards and reconstructed back to minimap pixels so the
same transform-consistency check used for hazards applies to the fairway too.

No club, bag, aim, recommendation, or strategy logic is used. Strategy authority is
always false.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import geometry_review_v1 as base
import fairway_spatial_shadow_v0 as fairway_spatial

SCHEMA_VERSION = "looper-geometry-review-v2"
STRATEGY_AUTHORITY = False

# Add fairway to the existing visual vocabulary. This is a review color only.
base.CLASS_STYLE["fairway"] = {"fill": "#4f8f58", "stroke": "#b9e7b1", "dash": ""}

_ORIGINAL_SPATIAL_LAYERS = base.hazard_layers_from_spatial
_ORIGINAL_SHADOW_LAYERS = base.hazard_layers_from_shadow
_ORIGINAL_BUILD_CAPTURE = base.build_capture_review
_ORIGINAL_RENDER_HOLE_HTML = base.render_hole_html
_CURRENT_CAPTURE: Path | None = None


def _surface_payload(capture: Path) -> dict[str, Any] | None:
    path = capture / "fairway_surface_shadow_v0.json"
    if not path.is_file():
        return None
    try:
        value = base.read_json(path)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def _fairway_layer(capture: Path, spatial: dict[str, Any] | None) -> list[dict[str, Any]]:
    payload = _surface_payload(capture)
    if not payload or not payload.get("fairway_present"):
        return []
    surface = payload.get("fairway")
    if not isinstance(surface, dict):
        return []

    direct = []
    for raw in surface.get("polygon_minimap_pixel") or []:
        point = base.point_xy(raw)
        if point is not None:
            direct.append(point)
    if len(direct) < 3:
        return []

    reconstructed: list[tuple[float, float]] = []
    projection_status = "direct-minimap"
    if spatial and spatial.get("transform"):
        try:
            projected = fairway_spatial.project(capture)
            projected_surface = projected.get("fairway") if isinstance(projected, dict) else None
            local = (projected_surface or {}).get("hole_local_yards") or []
            transform = spatial.get("transform") or {}
            for raw in local:
                if not isinstance(raw, dict):
                    continue
                lat = base.finite(raw.get("lateral_yds"))
                fwd = base.finite(raw.get("forward_yds"))
                if lat is None or fwd is None:
                    continue
                reconstructed.append(base.local_to_pixel(transform, lat, fwd))
            if len(reconstructed) == len(direct):
                projection_status = "hole-local-roundtrip"
            else:
                reconstructed = []
        except Exception:
            reconstructed = []

    confidence = {
        "semantic": surface.get("semantic_confidence"),
        "geometry": surface.get("segmentation_quality_score"),
    }
    return [{
        "id": "fairway-1",
        "class": "fairway",
        "geometry_type": "polygon",
        "source": {"kind": "fairway-surface-shadow-v0"},
        "confidence": confidence,
        "validation": {"topology": surface.get("topology") or {}},
        "direct_points": direct,
        "roundtrip_points": reconstructed,
        "render_points": reconstructed or direct,
        "render_mode": projection_status,
        "roundtrip": base.roundtrip_metrics(direct, reconstructed),
    }]


def _spatial_layers_with_fairway(spatial: dict[str, Any]) -> list[dict[str, Any]]:
    rows = _ORIGINAL_SPATIAL_LAYERS(spatial)
    if _CURRENT_CAPTURE is not None:
        rows.extend(_fairway_layer(_CURRENT_CAPTURE, spatial))
    return rows


def _shadow_layers_with_fairway(hazard_map: dict[str, Any], width: int, height: int) -> list[dict[str, Any]]:
    rows = _ORIGINAL_SHADOW_LAYERS(hazard_map, width, height)
    if _CURRENT_CAPTURE is not None:
        rows.extend(_fairway_layer(_CURRENT_CAPTURE, None))
    return rows


def _render_hole_html_v2(manifest, actual_uri, greens, layers, tee, pin) -> str:
    page = _ORIGINAL_RENDER_HOLE_HTML(manifest, actual_uri, greens, layers, tee, pin)
    page = page.replace(" hazard objects · ", " geometry objects · ")
    fairway_controls = '''
<label>Fairway presence<select data-review="fairway_presence"><option>unreviewed</option><option>pass</option><option>absent-correct</option><option>false-positive</option><option>missed</option><option>uncertain</option></select></label>
<label>Fairway position<select data-review="fairway_position"><option>unreviewed</option><option>pass</option><option>mixed</option><option>fail</option></select></label>
<label>Fairway width / size<select data-review="fairway_size"><option>unreviewed</option><option>pass</option><option>mixed</option><option>fail</option></select></label>
<label>Fairway boundary / shape<select data-review="fairway_shape"><option>unreviewed</option><option>pass</option><option>mixed</option><option>wrong-neighbor</option><option>fail</option></select></label>
'''
    marker = '<textarea data-review="notes"'
    if marker in page:
        page = page.replace(marker, fairway_controls + marker, 1)
    return page


def _build_capture_review_v2(capture: Path, hole_out: Path) -> dict[str, Any]:
    global _CURRENT_CAPTURE
    _CURRENT_CAPTURE = capture
    try:
        manifest = _ORIGINAL_BUILD_CAPTURE(capture, hole_out)
    finally:
        _CURRENT_CAPTURE = None

    fairway_payload = _surface_payload(capture)
    fairway_present = bool((fairway_payload or {}).get("fairway_present"))
    fairway_surface = (fairway_payload or {}).get("fairway") or {}
    manifest["schema_version"] = SCHEMA_VERSION
    manifest["fairway_review"] = {
        "surface_file": "fairway_surface_shadow_v0.json" if fairway_payload else None,
        "spatial_file": "fairway_spatial_shadow_v0.json" if (capture / "fairway_spatial_shadow_v0.json").is_file() else None,
        "present": fairway_present,
        "semantic_confidence": fairway_surface.get("semantic_confidence") if isinstance(fairway_surface, dict) else None,
        "segmentation_quality_score": fairway_surface.get("segmentation_quality_score") if isinstance(fairway_surface, dict) else None,
        "topology": fairway_surface.get("topology") if isinstance(fairway_surface, dict) else None,
        "strategy_authority": False,
    }
    manifest.setdefault("sources", {})["fairway_surface_shadow"] = str(capture / "fairway_surface_shadow_v0.json") if fairway_payload else None
    manifest["geometry_class_counts"] = dict(manifest.get("hazard_class_counts") or {})
    manifest["fairway_layer_count"] = 1 if fairway_present else 0
    manifest["strategy_authority"] = False
    manifest["promotion_decision"] = "none"
    base.write_json(hole_out / "manifest.json", manifest)
    return manifest


def main() -> int:
    # Patch only the v1 module instance used by this entry point. geometry_review_v1
    # remains unchanged for historical reproducibility.
    base.hazard_layers_from_spatial = _spatial_layers_with_fairway
    base.hazard_layers_from_shadow = _shadow_layers_with_fairway
    base.render_hole_html = _render_hole_html_v2
    base.build_capture_review = _build_capture_review_v2
    base.SCHEMA_VERSION = SCHEMA_VERSION
    return base.main()


if __name__ == "__main__":
    raise SystemExit(main())
