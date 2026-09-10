#!/usr/bin/env python3
"""Unified, source-neutral hazard geometry contract for Looper field-lab work.

Step 7 normalizes GKD, Unity/course assets, VLM boxes, prompt-segmentation/SAM
polygons, red-penalty CV, and legacy bunker/water CV into one deliberately
non-authoritative representation.  This module is pure Python/std-lib so every
probe can depend on it without pulling model/CV dependencies into the contract.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = "looper-hazard-geometry-v0"
BUNDLE_SCHEMA_VERSION = "looper-hazard-geometry-bundle-v0"
STRATEGY_AUTHORITY = False

ALLOWED_CLASSES = {
    "bunker",
    "water",
    "penalty_area",
    "out_of_bounds",
    "uncertain",
    "generic_hazard",
}
ALLOWED_SOURCE_KINDS = {
    "gkd",
    "unity_asset",
    "gemini_vlm",
    "vlm",
    "sam2",
    "prompt_segmentation",
    "red_penalty_cv",
    "legacy_bunker_cv",
    "legacy_water_cv",
    "legacy_cv",
    "unknown",
}
ALLOWED_SPACES = {
    "gspro_world_xz",
    "minimap_pixel",
    "minimap_normalized",
    "hole_local_yards",
    "unknown_asset_or_serialized_space",
}
ALLOWED_GEOMETRY_TYPES = {"polygon", "polyline", "bbox", "point_set", "mask_ref"}

CLASS_MAP = {
    "bunker": "bunker",
    "bunker_or_sand": "bunker",
    "sand": "bunker",
    "water": "water",
    "penalty": "penalty_area",
    "penalty_area": "penalty_area",
    "red_penalty": "penalty_area",
    "out_of_bounds": "out_of_bounds",
    "oob": "out_of_bounds",
    "uncertain": "uncertain",
    "hazard_unspecified": "generic_hazard",
    "generic_hazard": "generic_hazard",
}


def _finite(value: Any) -> float:
    if isinstance(value, bool):
        raise ValueError("boolean is not a coordinate/confidence")
    out = float(value)
    if not math.isfinite(out):
        raise ValueError("non-finite numeric value")
    return out


def _confidence(value: Any | None) -> float | None:
    if value is None:
        return None
    out = _finite(value)
    if not 0.0 <= out <= 1.0:
        raise ValueError(f"confidence outside [0,1]: {out}")
    return out


def _point_xy(value: Any) -> list[float]:
    if isinstance(value, dict):
        if "x" in value and "y" in value:
            return [_finite(value["x"]), _finite(value["y"])]
        if "x" in value and "z" in value:
            return [_finite(value["x"]), _finite(value["z"])]
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return [_finite(value[0]), _finite(value[1])]
    raise ValueError(f"invalid point: {value!r}")


def _world_point(value: Any) -> list[float]:
    if isinstance(value, dict) and "x" in value and "z" in value:
        return [_finite(value["x"]), _finite(value["z"])]
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return [_finite(value[0]), _finite(value[1])]
    raise ValueError(f"invalid x/z point: {value!r}")


def _normalize_class(value: Any) -> str:
    key = re.sub(r"[^a-z0-9_]+", "_", str(value or "").strip().lower()).strip("_")
    out = CLASS_MAP.get(key)
    if out is None:
        raise ValueError(f"unsupported hazard class {value!r}")
    return out


def _stable_id(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True, default=str)
    return "hg_" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:20]


def _identity(identity: dict[str, Any] | None) -> dict[str, Any]:
    identity = dict(identity or {})
    allowed = ("course_key", "course_name", "round_id", "hole_display", "hole_raw_zero_based", "capture_id")
    return {k: identity.get(k) for k in allowed if identity.get(k) is not None}


def representation(
    *,
    geometry_type: str,
    coordinate_space: str,
    points: Iterable[Any] | None = None,
    bbox: Iterable[Any] | None = None,
    mask_artifact: str | None = None,
    coordinate_authority: str = "diagnostic",
    comparable_to_gspro_world: bool = False,
    transform_status: str = "not-applicable",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if geometry_type not in ALLOWED_GEOMETRY_TYPES:
        raise ValueError(f"unsupported geometry_type {geometry_type!r}")
    if coordinate_space not in ALLOWED_SPACES:
        raise ValueError(f"unsupported coordinate_space {coordinate_space!r}")
    if comparable_to_gspro_world and coordinate_space != "gspro_world_xz":
        raise ValueError("only gspro_world_xz may be directly world-comparable")

    out: dict[str, Any] = {
        "geometry_type": geometry_type,
        "coordinate_space": coordinate_space,
        "coordinate_authority": str(coordinate_authority),
        "comparable_to_gspro_world": bool(comparable_to_gspro_world),
        "transform_status": str(transform_status),
    }
    if points is not None:
        parser = _world_point if coordinate_space == "gspro_world_xz" else _point_xy
        parsed = [parser(p) for p in points]
        if geometry_type == "polygon" and len(parsed) < 3:
            raise ValueError("polygon needs at least three points")
        if geometry_type == "polyline" and len(parsed) < 2:
            raise ValueError("polyline needs at least two points")
        if coordinate_space == "minimap_normalized":
            if any(not (0.0 <= axis <= 1.0) for p in parsed for axis in p[:2]):
                raise ValueError("normalized minimap coordinates outside [0,1]")
        out["points"] = parsed
    if bbox is not None:
        vals = [_finite(v) for v in bbox]
        if len(vals) != 4:
            raise ValueError("bbox needs [x1,y1,x2,y2]")
        if vals[2] <= vals[0] or vals[3] <= vals[1]:
            raise ValueError("bbox has non-positive area")
        if coordinate_space == "minimap_normalized" and any(not 0.0 <= v <= 1.0 for v in vals):
            raise ValueError("normalized bbox outside [0,1]")
        out["bbox"] = vals
    if mask_artifact is not None:
        out["mask_artifact"] = str(mask_artifact)
    if metadata:
        out["metadata"] = dict(metadata)

    if geometry_type in {"polygon", "polyline", "point_set"} and "points" not in out:
        raise ValueError(f"{geometry_type} requires points")
    if geometry_type == "bbox" and "bbox" not in out:
        raise ValueError("bbox representation requires bbox")
    if geometry_type == "mask_ref" and "mask_artifact" not in out:
        raise ValueError("mask_ref representation requires mask_artifact")
    return out


def make_geometry(
    *,
    hazard_class: str,
    source_kind: str,
    source_name: str,
    source_object_id: str | int | None,
    representations: list[dict[str, Any]],
    semantic_confidence: float | None = None,
    geometry_confidence: float | None = None,
    source_artifact: str | None = None,
    identity: dict[str, Any] | None = None,
    validation_state: str = "unvalidated-shadow",
    validation_evidence: list[dict[str, Any]] | None = None,
    diagnostics: dict[str, Any] | None = None,
    strategy_authority: bool = False,
) -> dict[str, Any]:
    if strategy_authority:
        raise ValueError("HazardGeometry v0 is shadow-only; strategy_authority cannot be true")
    cls = _normalize_class(hazard_class)
    if source_kind not in ALLOWED_SOURCE_KINDS:
        raise ValueError(f"unsupported source_kind {source_kind!r}")
    if not representations:
        raise ValueError("HazardGeometry requires at least one geometry representation")
    reps = [validate_representation(dict(rep)) for rep in representations]
    sem = _confidence(semantic_confidence)
    geo = _confidence(geometry_confidence)
    ident = _identity(identity)
    id_seed = {
        "class": cls,
        "source_kind": source_kind,
        "source_name": str(source_name),
        "source_artifact": source_artifact,
        "source_object_id": None if source_object_id is None else str(source_object_id),
        "identity": ident,
        "representations": reps,
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "geometry_id": _stable_id(id_seed),
        "hazard_class": cls,
        "source": {
            "kind": source_kind,
            "name": str(source_name),
            "artifact": str(source_artifact) if source_artifact is not None else None,
            "object_id": None if source_object_id is None else str(source_object_id),
        },
        "identity": ident,
        "confidence": {"semantic": sem, "geometry": geo},
        "representations": reps,
        "validation": {
            "state": str(validation_state),
            "evidence": list(validation_evidence or []),
        },
        "diagnostics": dict(diagnostics or {}),
        "strategy_authority": False,
    }


def validate_representation(rep: dict[str, Any]) -> dict[str, Any]:
    return representation(
        geometry_type=str(rep.get("geometry_type")),
        coordinate_space=str(rep.get("coordinate_space")),
        points=rep.get("points"),
        bbox=rep.get("bbox"),
        mask_artifact=rep.get("mask_artifact"),
        coordinate_authority=str(rep.get("coordinate_authority", "diagnostic")),
        comparable_to_gspro_world=bool(rep.get("comparable_to_gspro_world", False)),
        transform_status=str(rep.get("transform_status", "not-applicable")),
        metadata=rep.get("metadata") if isinstance(rep.get("metadata"), dict) else None,
    )


def validate_geometry(item: dict[str, Any]) -> dict[str, Any]:
    if item.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"wrong HazardGeometry schema: {item.get('schema_version')!r}")
    if item.get("strategy_authority") is not False:
        raise ValueError("HazardGeometry strategy_authority must be false")
    rebuilt = make_geometry(
        hazard_class=item.get("hazard_class"),
        source_kind=(item.get("source") or {}).get("kind"),
        source_name=(item.get("source") or {}).get("name"),
        source_artifact=(item.get("source") or {}).get("artifact"),
        source_object_id=(item.get("source") or {}).get("object_id"),
        identity=item.get("identity"),
        semantic_confidence=(item.get("confidence") or {}).get("semantic"),
        geometry_confidence=(item.get("confidence") or {}).get("geometry"),
        representations=item.get("representations") or [],
        validation_state=(item.get("validation") or {}).get("state", "unvalidated-shadow"),
        validation_evidence=(item.get("validation") or {}).get("evidence") or [],
        diagnostics=item.get("diagnostics") or {},
    )
    if item.get("geometry_id") and item["geometry_id"] != rebuilt["geometry_id"]:
        raise ValueError("geometry_id does not match deterministic content hash")
    return rebuilt


def _class_from_semantics(values: Iterable[Any], *, generic_default: bool = True) -> str | None:
    normalized = []
    for value in values:
        try:
            normalized.append(_normalize_class(value))
        except ValueError:
            continue
    # Prefer specific classes. Generic hazard must never become bunker by position/name alone.
    for preferred in ("bunker", "water", "penalty_area", "out_of_bounds", "uncertain", "generic_hazard"):
        if preferred in normalized:
            return preferred
    return "generic_hazard" if generic_default else None


def from_gkd_feature(feature: dict[str, Any], *, artifact: str = "features.json", identity: dict[str, Any] | None = None) -> dict[str, Any]:
    cls = _class_from_semantics(feature.get("semantic_candidates") or [])
    pts = feature.get("points_xyz") or feature.get("points") or []
    rep_type = "polygon" if feature.get("polygon_candidate") and len(pts) >= 3 else "point_set"
    rep = representation(
        geometry_type=rep_type,
        coordinate_space="gspro_world_xz",
        points=pts,
        coordinate_authority="field-established-gkd-world-frame",
        comparable_to_gspro_world=True,
        transform_status="direct-xz-field-established",
        metadata={"json_path": feature.get("json_path"), "hole_hint": feature.get("hole_hint")},
    )
    return make_geometry(
        hazard_class=cls,
        source_kind="gkd",
        source_name=str(feature.get("source") or "GKD"),
        source_artifact=artifact,
        source_object_id=feature.get("feature_id") or feature.get("json_path"),
        identity=identity,
        representations=[rep],
        semantic_confidence=None,
        geometry_confidence=None,
        diagnostics={"semantic_candidates": feature.get("semantic_candidates") or [], "supporting_fields": feature.get("supporting_fields") or {}},
    )


def from_unity_geometry(row: dict[str, Any], *, artifact: str = "geometry_candidates.json", identity: dict[str, Any] | None = None) -> dict[str, Any]:
    hit_map = row.get("seed_semantic_hits") or row.get("semantic_hits") or {}
    raw_classes = list(hit_map.keys()) if isinstance(hit_map, dict) else []
    cls = _class_from_semantics(raw_classes)
    pts = row.get("points") or row.get("points_xyz") or []
    rep_type = "polygon" if row.get("polygon_candidate") and len(pts) >= 3 else "point_set"
    rep = representation(
        geometry_type=rep_type,
        coordinate_space="unknown_asset_or_serialized_space",
        points=pts,
        coordinate_authority="unproven-unity-serialized-space",
        comparable_to_gspro_world=False,
        transform_status="awaiting-field-transform-validation",
        metadata={"asset_file": row.get("asset_file"), "path_id": row.get("path_id"), "json_path": row.get("json_path")},
    )
    return make_geometry(
        hazard_class=cls,
        source_kind="unity_asset",
        source_name=str(row.get("asset_file") or "Unity course asset"),
        source_artifact=artifact,
        source_object_id=row.get("path_id") or row.get("object_path_id") or row.get("json_path"),
        identity=identity,
        representations=[rep],
        semantic_confidence=None,
        geometry_confidence=None,
        diagnostics={"seed_semantic_hits": hit_map, "semantic_score_effective": row.get("semantic_score_effective")},
    )


def from_vlm_hazard(item: dict[str, Any], *, source_kind: str = "gemini_vlm", source_name: str = "Gemini VLM", artifact: str | None = None, identity: dict[str, Any] | None = None) -> dict[str, Any]:
    cls = _normalize_class(item.get("hazard_class") or item.get("class") or item.get("type"))
    bbox = item.get("bbox_norm") or item.get("semantic_bbox_norm")
    rep = representation(
        geometry_type="bbox",
        coordinate_space="minimap_normalized",
        bbox=bbox,
        coordinate_authority="semantic-localization-only",
        comparable_to_gspro_world=False,
        transform_status="image-space-only",
    )
    return make_geometry(
        hazard_class=cls,
        source_kind=source_kind,
        source_name=source_name,
        source_artifact=artifact,
        source_object_id=item.get("hazard_id") or item.get("id"),
        identity=identity,
        semantic_confidence=item.get("semantic_confidence", item.get("confidence")),
        geometry_confidence=None,
        representations=[rep],
        diagnostics={"note": item.get("note")},
    )


def from_sam_object(item: dict[str, Any], *, source_name: str = "SAM2 prompt segmentation", artifact: str | None = None, mask_artifact: str | None = None, identity: dict[str, Any] | None = None) -> dict[str, Any]:
    cls = _normalize_class(item.get("hazard_class"))
    reps: list[dict[str, Any]] = []
    if item.get("semantic_bbox_norm"):
        reps.append(representation(
            geometry_type="bbox", coordinate_space="minimap_normalized", bbox=item["semantic_bbox_norm"],
            coordinate_authority="gemini-semantic-prompt", transform_status="image-space-only",
        ))
    poly_px = item.get("polygon_px") or []
    if len(poly_px) >= 3:
        reps.append(representation(
            geometry_type="polygon", coordinate_space="minimap_pixel", points=poly_px,
            coordinate_authority="prompt-segmenter", transform_status="image-space-only",
            metadata={"segmentation_status": item.get("segmentation_status")},
        ))
    poly_norm = item.get("polygon_norm") or []
    if len(poly_norm) >= 3:
        reps.append(representation(
            geometry_type="polygon", coordinate_space="minimap_normalized", points=poly_norm,
            coordinate_authority="prompt-segmenter", transform_status="image-space-only",
            metadata={"segmentation_status": item.get("segmentation_status")},
        ))
    if mask_artifact:
        reps.append(representation(
            geometry_type="mask_ref", coordinate_space="minimap_pixel", mask_artifact=mask_artifact,
            coordinate_authority="prompt-segmenter", transform_status="image-space-only",
        ))
    if not reps:
        raise ValueError("SAM/prompt-segmentation object has no usable geometry")
    quality = item.get("segmentation_quality_score") if item.get("segmentation_status") == "accepted" else None
    # SAM's internal quality is preserved separately from semantic confidence.
    return make_geometry(
        hazard_class=cls,
        source_kind="sam2",
        source_name=source_name,
        source_artifact=artifact,
        source_object_id=item.get("hazard_id") or item.get("id"),
        identity=identity,
        semantic_confidence=item.get("semantic_confidence"),
        geometry_confidence=quality if quality is not None and 0 <= float(quality) <= 1 else None,
        representations=reps,
        validation_state="segmentation-accepted-unvalidated" if item.get("segmentation_status") == "accepted" else "segmentation-rejected",
        diagnostics={
            "segmentation_status": item.get("segmentation_status"),
            "reject_reasons": item.get("segmentation_reject_reasons") or [],
            "model_mask_score": item.get("model_mask_score"),
            "metrics": item.get("metrics") or {},
        },
    )


def from_refined_vlm_object(item: dict[str, Any], *, artifact: str | None = None, identity: dict[str, Any] | None = None) -> dict[str, Any]:
    cls = _normalize_class(item.get("hazard_class"))
    reps: list[dict[str, Any]] = []
    if item.get("bbox_norm"):
        reps.append(representation(geometry_type="bbox", coordinate_space="minimap_normalized", bbox=item["bbox_norm"], coordinate_authority="vlm-semantic-localization", transform_status="image-space-only"))
    if len(item.get("polygon_px") or []) >= 3:
        reps.append(representation(geometry_type="polygon", coordinate_space="minimap_pixel", points=item["polygon_px"], coordinate_authority="legacy-cv-inside-vlm-roi", transform_status="image-space-only"))
    if len(item.get("polygon_norm") or []) >= 3:
        reps.append(representation(geometry_type="polygon", coordinate_space="minimap_normalized", points=item["polygon_norm"], coordinate_authority="legacy-cv-inside-vlm-roi", transform_status="image-space-only"))
    return make_geometry(
        hazard_class=cls,
        source_kind="legacy_cv",
        source_name="legacy CV refinement inside VLM ROI",
        source_artifact=artifact,
        source_object_id=item.get("hazard_id"),
        identity=identity,
        semantic_confidence=item.get("vlm_confidence"),
        geometry_confidence=item.get("refinement_confidence"),
        representations=reps,
        validation_state="legacy-baseline-unvalidated",
        diagnostics={"refinement_status": item.get("refinement_status"), **(item.get("diagnostics") or {})},
    )


def from_red_penalty_object(item: dict[str, Any], *, artifact: str | None = None, identity: dict[str, Any] | None = None) -> dict[str, Any]:
    # Adapter is intentionally tolerant because historical red-CV artifacts evolved.
    poly = item.get("polygon_px") or item.get("polyline_px") or item.get("points_px") or item.get("points") or []
    norm = item.get("polygon_norm") or item.get("polyline_norm") or []
    reps: list[dict[str, Any]] = []
    if len(poly) >= 3:
        reps.append(representation(geometry_type="polygon", coordinate_space="minimap_pixel", points=poly, coordinate_authority="deterministic-red-line-cv", transform_status="image-space-only"))
    elif len(poly) >= 2:
        reps.append(representation(geometry_type="polyline", coordinate_space="minimap_pixel", points=poly, coordinate_authority="deterministic-red-line-cv", transform_status="image-space-only"))
    if len(norm) >= 3:
        reps.append(representation(geometry_type="polygon", coordinate_space="minimap_normalized", points=norm, coordinate_authority="deterministic-red-line-cv", transform_status="image-space-only"))
    elif len(norm) >= 2:
        reps.append(representation(geometry_type="polyline", coordinate_space="minimap_normalized", points=norm, coordinate_authority="deterministic-red-line-cv", transform_status="image-space-only"))
    if not reps:
        raise ValueError("red-penalty object contains no recognized line/polygon geometry")
    return make_geometry(
        hazard_class="penalty_area",
        source_kind="red_penalty_cv",
        source_name="GSPro red penalty boundary CV",
        source_artifact=artifact,
        source_object_id=item.get("id") or item.get("object_id") or item.get("feature_id"),
        identity=identity,
        semantic_confidence=item.get("confidence"),
        geometry_confidence=item.get("geometry_confidence", item.get("confidence")),
        representations=reps,
        validation_state="red-cv-shadow-unvalidated",
        diagnostics={k: v for k, v in item.items() if k not in {"polygon_px", "polyline_px", "points_px", "points", "polygon_norm", "polyline_norm"}},
    )


def from_legacy_cv_object(item: dict[str, Any], *, hazard_class: str, artifact: str | None = None, identity: dict[str, Any] | None = None) -> dict[str, Any]:
    cls = _normalize_class(hazard_class)
    poly = item.get("polygon_px") or item.get("polygon") or item.get("contour_px") or item.get("points") or []
    norm = item.get("polygon_norm") or []
    bbox = item.get("bbox_norm")
    reps: list[dict[str, Any]] = []
    if len(poly) >= 3:
        reps.append(representation(geometry_type="polygon", coordinate_space="minimap_pixel", points=poly, coordinate_authority="legacy-global-cv", transform_status="image-space-only"))
    if len(norm) >= 3:
        reps.append(representation(geometry_type="polygon", coordinate_space="minimap_normalized", points=norm, coordinate_authority="legacy-global-cv", transform_status="image-space-only"))
    if bbox:
        reps.append(representation(geometry_type="bbox", coordinate_space="minimap_normalized", bbox=bbox, coordinate_authority="legacy-global-cv", transform_status="image-space-only"))
    if not reps:
        raise ValueError("legacy CV object contains no recognized geometry")
    kind = "legacy_bunker_cv" if cls == "bunker" else "legacy_water_cv" if cls == "water" else "legacy_cv"
    return make_geometry(
        hazard_class=cls,
        source_kind=kind,
        source_name=f"legacy {cls} CV",
        source_artifact=artifact,
        source_object_id=item.get("id") or item.get("object_id") or item.get("feature_id"),
        identity=identity,
        semantic_confidence=item.get("confidence"),
        geometry_confidence=item.get("geometry_confidence", item.get("confidence")),
        representations=reps,
        validation_state="legacy-baseline-unvalidated",
        diagnostics={"original_status": item.get("status")},
    )


def _vlm_response_objects(payload: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for field, cls in (("bunkers", "bunker"), ("water", "water"), ("uncertain", "uncertain")):
        for item in payload.get(field) or []:
            if isinstance(item, dict):
                out.append({**item, "hazard_class": cls, "hazard_id": item.get("id")})
    return out


def normalize_payload(payload: Any, *, artifact: str, source_hint: str | None = None, identity: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Best-effort adapter for existing field-lab JSON artifacts.

    Returns (objects, errors). Adapter errors are retained instead of aborting the
    whole bundle because the next field run is explicitly designed to over-collect.
    """
    objects: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    hint = (source_hint or "").lower()
    base = Path(artifact).name.lower()

    def add(fn, row, index):
        try:
            objects.append(fn(row))
        except Exception as exc:
            errors.append({"artifact": artifact, "index": index, "error": f"{type(exc).__name__}: {exc}"})

    if isinstance(payload, dict) and isinstance(payload.get("features"), list):
        for i, row in enumerate(payload["features"]):
            if isinstance(row, dict): add(lambda r: from_gkd_feature(r, artifact=artifact, identity=identity), row, i)
        return objects, errors

    if isinstance(payload, dict) and isinstance(payload.get("geometry"), list):
        for i, row in enumerate(payload["geometry"]):
            if isinstance(row, dict): add(lambda r: from_unity_geometry(r, artifact=artifact, identity=identity), row, i)
        return objects, errors

    schema = payload.get("schema_version") if isinstance(payload, dict) else None
    if schema == "looper-hazard-vlm-v0":
        for i, row in enumerate(_vlm_response_objects(payload)):
            add(lambda r: from_vlm_hazard(r, artifact=artifact, identity=identity), row, i)
        return objects, errors

    if isinstance(payload, dict) and schema == "looper-hazard-prompt-segment-v0":
        for i, row in enumerate(payload.get("objects") or []):
            if isinstance(row, dict): add(lambda r: from_sam_object(r, artifact=artifact, identity=identity), row, i)
        return objects, errors

    # Saved SAM result artifacts may lose/rename the top-level schema but preserve object shape.
    if isinstance(payload, dict) and isinstance(payload.get("objects"), list) and any("segmentation_status" in x for x in payload["objects"] if isinstance(x, dict)):
        for i, row in enumerate(payload["objects"]):
            if isinstance(row, dict): add(lambda r: from_sam_object(r, artifact=artifact, identity=identity), row, i)
        return objects, errors

    # Existing VLM-shadow refined objects.
    if isinstance(payload, dict) and isinstance(payload.get("objects"), list) and any("refinement_status" in x for x in payload["objects"] if isinstance(x, dict)):
        for i, row in enumerate(payload["objects"]):
            if isinstance(row, dict): add(lambda r: from_refined_vlm_object(r, artifact=artifact, identity=identity), row, i)
        return objects, errors

    if isinstance(payload, dict) and isinstance(payload.get("objects"), list) and ("red" in hint or "penalty" in hint or "red" in base or "penalty" in base):
        for i, row in enumerate(payload["objects"]):
            if isinstance(row, dict): add(lambda r: from_red_penalty_object(r, artifact=artifact, identity=identity), row, i)
        return objects, errors

    if isinstance(payload, dict) and isinstance(payload.get("objects"), list) and ("bunker" in hint or "bunker" in base):
        for i, row in enumerate(payload["objects"]):
            if isinstance(row, dict): add(lambda r: from_legacy_cv_object(r, hazard_class="bunker", artifact=artifact, identity=identity), row, i)
        return objects, errors

    if isinstance(payload, dict) and isinstance(payload.get("objects"), list) and ("water" in hint or "water" in base):
        for i, row in enumerate(payload["objects"]):
            if isinstance(row, dict): add(lambda r: from_legacy_cv_object(r, hazard_class="water", artifact=artifact, identity=identity), row, i)
        return objects, errors

    errors.append({"artifact": artifact, "error": f"unrecognized artifact shape/schema {schema!r}"})
    return objects, errors


def bundle(objects: Iterable[dict[str, Any]], *, errors: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    rows = [validate_geometry(dict(item)) for item in objects]
    # Deduplicate exact source/geometry objects while preserving cross-source disagreement.
    unique = {row["geometry_id"]: row for row in rows}
    rows = [unique[k] for k in sorted(unique)]
    counts: dict[str, int] = {}
    sources: dict[str, int] = {}
    for row in rows:
        counts[row["hazard_class"]] = counts.get(row["hazard_class"], 0) + 1
        kind = row["source"]["kind"]
        sources[kind] = sources.get(kind, 0) + 1
    return {
        "schema_version": BUNDLE_SCHEMA_VERSION,
        "strategy_authority": False,
        "object_count": len(rows),
        "class_counts": counts,
        "source_counts": sources,
        "objects": rows,
        "adapter_errors": list(errors or []),
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Normalize existing Looper hazard artifacts into HazardGeometry v0")
    p.add_argument("--input", action="append", required=True, help="JSON artifact; repeatable")
    p.add_argument("--output", required=True)
    p.add_argument("--source-hint", action="append", default=[], help="Optional source hint aligned with --input")
    p.add_argument("--course-key")
    p.add_argument("--course-name")
    p.add_argument("--round-id")
    p.add_argument("--hole", type=int)
    p.add_argument("--capture-id")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    ident = _identity({
        "course_key": args.course_key,
        "course_name": args.course_name,
        "round_id": args.round_id,
        "hole_display": args.hole,
        "hole_raw_zero_based": args.hole - 1 if args.hole is not None else None,
        "capture_id": args.capture_id,
    })
    all_objects: list[dict[str, Any]] = []
    all_errors: list[dict[str, Any]] = []
    for i, raw_path in enumerate(args.input):
        path = Path(raw_path)
        hint = args.source_hint[i] if i < len(args.source_hint) else None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            rows, errors = normalize_payload(payload, artifact=str(path), source_hint=hint, identity=ident)
            all_objects.extend(rows)
            all_errors.extend(errors)
        except Exception as exc:
            all_errors.append({"artifact": str(path), "error": f"{type(exc).__name__}: {exc}"})
    out = bundle(all_objects, errors=all_errors)
    dest = Path(args.output)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"HazardGeometry v0: {out['object_count']} objects from {len(args.input)} artifacts; adapter errors={len(all_errors)}")
    print(f"Output: {dest}")
    return 0 if out["object_count"] or not all_errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
