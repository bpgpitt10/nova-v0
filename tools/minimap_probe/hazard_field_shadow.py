#!/usr/bin/env python3
"""Step 8 field-lab tee hazard orchestrator.

Runs after the resilient tee probe has saved its replayable minimap artifacts.  It
collects every available hazard source into HazardGeometry v0 without changing live
GSPro state or granting any source strategy authority.

Production note: this is field-validation tooling only.  It is not the deployment
architecture for looper.golf and must not create a required local companion.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any

import hazard_geometry_contract as hg

SCHEMA_VERSION = "looper-hazard-field-shadow-v0"
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
DEFAULT_SAM_MODEL = "facebook/sam2.1-hiera-tiny"


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _atomic_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    tmp.replace(path)


def _slug(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in value)


def _wait_for_context(capture: Path, seconds: float) -> dict[str, Any] | None:
    path = capture / "capture_context.json"
    deadline = time.time() + max(0.0, seconds)
    while time.time() <= deadline:
        if path.exists():
            try:
                return _read_json(path)
            except Exception:
                pass
        time.sleep(0.20)
    return None


def _identity(capture: Path, model: dict[str, Any], context: dict[str, Any] | None) -> dict[str, Any]:
    context = context or {}
    nested = context.get("identity") if isinstance(context.get("identity"), dict) else {}
    hole = context.get("hole_number") or nested.get("hole_number")
    try:
        hole = int(hole) if hole is not None else None
    except Exception:
        hole = None
    return {
        "course_key": context.get("course_key") or nested.get("course_key"),
        "course_name": context.get("course_name") or nested.get("course_name"),
        "round_id": context.get("round_id") or context.get("db_round_id"),
        "hole_display": hole,
        "hole_raw_zero_based": hole - 1 if hole is not None else None,
        "capture_id": capture.name,
    }


def _semantic_image(capture: Path, model: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    candidates = (
        "tee_hazard_safe_minimap.png",
        "tee_canonical_minimap.png",
        "tee_initial_minimap.png",
        "watcher_prelaunch_minimap.png",
        "tee_heatmap_minimap.png",
    )
    path = next((capture / name for name in candidates if (capture / name).exists()), None)
    if path is None:
        raise RuntimeError("no saved tee minimap image found")

    hazards = model.get("hazards") if isinstance(model.get("hazards"), dict) else {}
    selection = hazards.get("normal_frame_selection") if isinstance(hazards.get("normal_frame_selection"), dict) else {}
    green = model.get("green_surface") if isinstance(model.get("green_surface"), dict) else {}
    capture_meta = model.get("capture") if isinstance(model.get("capture"), dict) else {}
    normal_confirmed = bool(selection.get("trusted_for_red_penalty"))
    heatmap_explicit = path.name == "tee_heatmap_minimap.png"
    confirmed = bool(normal_confirmed and not heatmap_explicit)
    if confirmed:
        status = "confirmed-heatmap-off"
    elif heatmap_explicit:
        status = "known-heatmap-image"
    else:
        status = "unconfirmed-as-presented"
    return path, {
        "source_image": path.name,
        "status": status,
        "confirmed_heatmap_off": confirmed,
        "normal_frame_selection": selection,
        "green_available": green.get("available"),
        "canonical_mode": (model.get("minimap") or {}).get("canonical_mode") if isinstance(model.get("minimap"), dict) else None,
        "heatmap_pair_available": capture_meta.get("heatmap_pair_available"),
        "heatmap_toggle_warning": capture_meta.get("heatmap_toggle_warning"),
        "policy": "fresh semantic models require confirmed heatmap-off unless diagnostic override is explicit",
    }


def _run_legacy_shadow(capture: Path, timeout_seconds: float) -> dict[str, Any]:
    script = Path(__file__).with_name("hazard_shadow_capture.py")
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            [sys.executable, str(script), "--capture-dir", str(capture)],
            cwd=str(script.parent),
            check=False,
            capture_output=True,
            text=True,
            timeout=max(10.0, timeout_seconds),
        )
        payload_path = capture / "hazard_shadow_v0.json"
        payload = _read_json(payload_path) if payload_path.exists() else None
        return {
            "status": "complete" if payload is not None else "missing-output",
            "exit_code": completed.returncode,
            "elapsed_seconds": time.perf_counter() - started,
            "stdout_tail": (completed.stdout or "")[-1200:],
            "stderr_tail": (completed.stderr or "")[-1200:],
            "artifact": payload_path.name if payload_path.exists() else None,
            "payload": payload,
        }
    except Exception as exc:
        return {
            "status": "error",
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_seconds": time.perf_counter() - started,
            "payload": None,
        }


def _yard_polygon(row: dict[str, Any]) -> list[list[float]]:
    out: list[list[float]] = []
    for point in row.get("polygon_yards") or []:
        if not isinstance(point, dict):
            continue
        try:
            lateral = float(point["lateral_yds"])
            forward = float(point["forward_yds"])
        except Exception:
            continue
        out.append([lateral, forward])
    return out


def _legacy_geometry(
    row: dict[str, Any],
    *,
    hazard_class: str,
    artifact: str,
    identity: dict[str, Any],
) -> dict[str, Any]:
    pixel = row.get("polygon_pixel") or []
    yards = _yard_polygon(row)
    reps: list[dict[str, Any]] = []
    if len(pixel) >= 3:
        reps.append(hg.representation(
            geometry_type="polygon",
            coordinate_space="minimap_pixel",
            points=pixel,
            coordinate_authority="legacy-global-cv-visible-component",
            transform_status="image-space-only",
        ))
    if len(yards) >= 3:
        reps.append(hg.representation(
            geometry_type="polygon",
            coordinate_space="hole_local_yards",
            points=yards,
            coordinate_authority="legacy-global-cv-ball-pin-local-transform",
            transform_status="ball-pin-local-frame",
            metadata={"x_axis": "lateral_yds_right_positive", "y_axis": "forward_yds_toward_pin"},
        ))
    if not reps:
        raise ValueError("legacy object has no polygon_pixel/polygon_yards geometry")
    confidence = row.get("confidence")
    source_kind = "legacy_bunker_cv" if hazard_class == "bunker" else "legacy_water_cv"
    return hg.make_geometry(
        hazard_class=hazard_class,
        source_kind=source_kind,
        source_name=f"legacy {hazard_class} whole-image CV field baseline",
        source_artifact=artifact,
        source_object_id=row.get("object_id"),
        identity=identity,
        semantic_confidence=confidence,
        geometry_confidence=None,
        representations=reps,
        validation_state="legacy-baseline-unvalidated",
        diagnostics={
            "area_px": row.get("area_px"),
            "nearest_yds": row.get("nearest_yds"),
            "farthest_yds": row.get("farthest_yds"),
            "corridor_entry_yds": row.get("corridor_entry_yds"),
            "corridor_exit_yds": row.get("corridor_exit_yds"),
            "extractor_diagnostics": row.get("diagnostics") or {},
        },
    )


def _red_geometry(row: dict[str, Any], *, artifact: str, identity: dict[str, Any]) -> dict[str, Any]:
    reps: list[dict[str, Any]] = []
    try:
        lmin = float(row["lateral_min_yds"])
        lmax = float(row["lateral_max_yds"])
        fmin = float(row["forward_min_yds"])
        fmax = float(row["forward_max_yds"])
        if lmax > lmin and fmax > fmin:
            reps.append(hg.representation(
                geometry_type="bbox",
                coordinate_space="hole_local_yards",
                bbox=[lmin, fmin, lmax, fmax],
                coordinate_authority="red-penalty-cv-derived-extents",
                transform_status="ball-pin-local-frame",
                metadata={
                    "x_axis": "lateral_yds_right_positive",
                    "y_axis": "forward_yds_toward_pin",
                    "important": "extent envelope, not an exact penalty polygon",
                },
            ))
    except Exception:
        pass
    crossings: list[list[float]] = []
    for value in row.get("centerline_crossings_yds") or []:
        try:
            crossings.append([0.0, float(value)])
        except Exception:
            pass
    if crossings:
        reps.append(hg.representation(
            geometry_type="point_set",
            coordinate_space="hole_local_yards",
            points=crossings,
            coordinate_authority="red-penalty-cv-centerline-crossings",
            transform_status="ball-pin-local-frame",
            metadata={"x_axis": "lateral_yds", "y_axis": "forward_yds"},
        ))
    if not reps:
        raise ValueError("red penalty object has no usable current-schema geometry")
    return hg.make_geometry(
        hazard_class="penalty_area",
        source_kind="red_penalty_cv",
        source_name="GSPro red penalty boundary CV",
        source_artifact=artifact,
        source_object_id=row.get("object_id"),
        identity=identity,
        semantic_confidence=None,
        geometry_confidence=None,
        representations=reps,
        validation_state="red-cv-shadow-unvalidated",
        diagnostics={
            "nearest_yds": row.get("nearest_yds"),
            "farthest_yds": row.get("farthest_yds"),
            "median_lateral_yds": row.get("median_lateral_yds"),
            "corridor_entry_yds": row.get("corridor_entry_yds"),
            "corridor_exit_yds": row.get("corridor_exit_yds"),
            "semantic_rule": "red boundary means penalty_area; never infer water from red alone",
        },
    )


def _collect_existing_artifact(
    path: Path,
    *,
    identity: dict[str, Any],
    hint: str | None,
    objects: list[dict[str, Any]],
    errors: list[dict[str, Any]],
) -> None:
    try:
        rows, problems = hg.normalize_payload(
            _read_json(path), artifact=str(path), source_hint=hint, identity=identity
        )
        objects.extend(rows)
        errors.extend(problems)
    except Exception as exc:
        errors.append({"artifact": str(path), "error": f"{type(exc).__name__}: {exc}"})


def _collect_red(model: dict[str, Any], identity: dict[str, Any], objects: list[dict[str, Any]], errors: list[dict[str, Any]]) -> dict[str, Any]:
    rows = ((model.get("hazards") or {}).get("penalty_objects") or []) if isinstance(model.get("hazards"), dict) else []
    accepted = 0
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        try:
            objects.append(_red_geometry(row, artifact="hole_model.json#hazards.penalty_objects", identity=identity))
            accepted += 1
        except Exception as exc:
            errors.append({"source": "red_penalty_cv", "index": i, "error": f"{type(exc).__name__}: {exc}"})
    return {"status": "collected", "input_objects": len(rows), "geometry_objects": accepted}


def _collect_legacy(payload: dict[str, Any] | None, identity: dict[str, Any], objects: list[dict[str, Any]], errors: list[dict[str, Any]]) -> dict[str, Any]:
    status: dict[str, Any] = {}
    for cls in ("bunker", "water"):
        section = (payload or {}).get(cls) if isinstance(payload, dict) else None
        rows = section.get("objects") or [] if isinstance(section, dict) else []
        made = 0
        for i, row in enumerate(rows):
            if not isinstance(row, dict):
                continue
            try:
                objects.append(_legacy_geometry(row, hazard_class=cls, artifact="hazard_shadow_v0.json", identity=identity))
                made += 1
            except Exception as exc:
                errors.append({"source": f"legacy_{cls}_cv", "index": i, "error": f"{type(exc).__name__}: {exc}"})
        status[cls] = {
            "run_status": section.get("status") if isinstance(section, dict) else "missing",
            "candidate_count": (section or {}).get("candidate_count", (section or {}).get("candidate_count_without_geometry")) if isinstance(section, dict) else None,
            "accepted_count": (section or {}).get("accepted_count") if isinstance(section, dict) else None,
            "geometry_objects": made,
            "zero_results_are_retained": True,
        }
    return status


def _fresh_gemini(
    capture: Path,
    image_path: Path,
    model_name: str,
    timeout_seconds: float,
    identity: dict[str, Any],
    objects: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any] | None, list[Any]]:
    import hazard_vlm_contract
    import hazard_vlm_gemini_boxes

    started = time.perf_counter()
    contract, meta, native = hazard_vlm_gemini_boxes.call_gemini_boxes(
        image_path=image_path,
        model=model_name,
        timeout_seconds=timeout_seconds,
    )
    slug = _slug(model_name)
    contract_path = capture / f"hazard_vlm_response_{slug}_boxes_v0.json"
    raw_path = capture / f"hazard_vlm_provider_raw_{slug}_boxes_v0.json"
    meta_path = capture / f"hazard_vlm_meta_{slug}_boxes_v0.json"
    _atomic_json(contract_path, contract)
    _atomic_json(raw_path, native)
    _atomic_json(meta_path, meta)
    hazards = hazard_vlm_contract.parse_response(contract)
    rows = []
    for item in hazards:
        raw = {
            "hazard_id": item.hazard_id,
            "hazard_class": item.hazard_class,
            "confidence": item.confidence,
            "bbox_norm": list(item.bbox_norm),
            "note": item.note,
        }
        rows.append(hg.from_vlm_hazard(
            raw,
            source_kind="gemini_vlm",
            source_name=f"Gemini {model_name}",
            artifact=contract_path.name,
            identity=identity,
        ))
    objects.extend(rows)
    return {
        "status": "complete",
        "model": model_name,
        "elapsed_seconds": time.perf_counter() - started,
        "hazard_counts": meta.get("hazard_counts") or {},
        "usage_metadata": meta.get("usage_metadata") or {},
        "artifacts": [contract_path.name, raw_path.name, meta_path.name],
        "geometry_objects": len(rows),
    }, contract, hazards


def _fresh_sam(
    capture: Path,
    image_path: Path,
    hazards: list[Any],
    model_name: str,
    gemini_model: str,
    identity: dict[str, Any],
    objects: list[dict[str, Any]],
) -> dict[str, Any]:
    import cv2
    import hazard_prompt_segment

    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"could not read {image_path}")
    backend = hazard_prompt_segment.Sam2TransformersBackend(model_name, "auto")
    payload = hazard_prompt_segment.segment_hazards(image, hazards, backend)
    prefix = f"hazard_sam2_{_slug(gemini_model)}"
    artifact_rows = list(payload.get("objects") or [])
    artifacts = hazard_prompt_segment.save_artifacts(capture, image, payload, prefix=prefix)
    made = 0
    for row in artifact_rows:
        if not isinstance(row, dict):
            continue
        mask_ref = None
        if row.get("segmentation_status") == "accepted":
            safe_id = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(row.get("hazard_id") or "hazard"))
            mask_ref = f"{artifacts['mask_dir']}/{safe_id}.png"
        try:
            objects.append(hg.from_sam_object(
                row,
                source_name=f"SAM2 {model_name} prompted by Gemini {gemini_model}",
                artifact=artifacts["result"],
                mask_artifact=mask_ref,
                identity=identity,
            ))
            made += 1
        except Exception:
            # Rejected/no-geometry SAM rows remain preserved in the SAM JSON artifact.
            pass
    return {
        "status": "complete",
        "model": model_name,
        "device": payload.get("device"),
        "latency_seconds": payload.get("latency_seconds"),
        "input_objects": payload.get("object_count"),
        "accepted_masks": payload.get("accepted_count"),
        "geometry_objects": made,
        "artifacts": artifacts,
    }


def _update_hole_model(capture: Path, manifest_name: str, bundle_name: str, source_status: dict[str, Any]) -> None:
    path = capture / "hole_model.json"
    if not path.exists():
        return
    model = _read_json(path)
    hazards = model.setdefault("hazards", {})
    hazards["field_shadow"] = {
        "validation_state": "field-shadow-unvalidated",
        "trusted_for_strategy": False,
        "strategy_authority": False,
        "manifest": manifest_name,
        "hazard_geometry_bundle": bundle_name,
        "source_status": source_status,
    }
    layers = model.setdefault("semantic_layers", {})
    layers["bunker"] = "shadow-collected-not-promoted"
    layers["water"] = "shadow-collected-not-promoted"
    _atomic_json(path, model)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Looper Step 8 unified hazard shadow orchestrator")
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--gemini-model", default=DEFAULT_GEMINI_MODEL)
    p.add_argument("--sam-model", default=DEFAULT_SAM_MODEL)
    p.add_argument("--timeout", type=float, default=90.0)
    p.add_argument("--wait-context-seconds", type=float, default=8.0)
    p.add_argument("--no-gemini", action="store_true")
    p.add_argument("--no-sam", action="store_true")
    p.add_argument("--allow-unconfirmed-semantic-image", action="store_true")
    p.add_argument("--extra-input", action="append", default=[])
    return p.parse_args()


def main() -> int:
    args = parse_args()
    capture = Path(args.capture_dir).expanduser().resolve()
    manifest_path = capture / "hazard_field_shadow_v0.json"
    bundle_path = capture / "hazard_geometry_v0.json"
    started = time.perf_counter()
    errors: list[dict[str, Any]] = []
    objects: list[dict[str, Any]] = []
    source_status: dict[str, Any] = {}

    try:
        if not capture.is_dir():
            raise RuntimeError(f"capture directory missing: {capture}")
        model_path = capture / "hole_model.json"
        if not model_path.exists():
            raise RuntimeError("hole_model.json missing")
        model = _read_json(model_path)
        context = _wait_for_context(capture, args.wait_context_seconds)
        ident = _identity(capture, model, context)
        image_path, image_policy = _semantic_image(capture, model)

        legacy = _run_legacy_shadow(capture, min(60.0, args.timeout))
        source_status["legacy_runner"] = {k: v for k, v in legacy.items() if k != "payload"}
        # Reload because the legacy runner attaches its shadow record to HoleModel.
        try:
            model = _read_json(model_path)
        except Exception:
            pass
        source_status["red_penalty_cv"] = _collect_red(model, ident, objects, errors)
        source_status["legacy_cv"] = _collect_legacy(legacy.get("payload"), ident, objects, errors)

        semantic_allowed = bool(image_policy["confirmed_heatmap_off"] or args.allow_unconfirmed_semantic_image)
        contract = None
        hazards: list[Any] = []
        if args.no_gemini:
            source_status["gemini"] = {"status": "disabled-by-argument"}
        elif not semantic_allowed:
            source_status["gemini"] = {"status": "skipped-unconfirmed-heatmap-state"}
        elif not os.environ.get("GEMINI_API_KEY"):
            source_status["gemini"] = {"status": "skipped-no-api-key"}
        else:
            try:
                source_status["gemini"], contract, hazards = _fresh_gemini(
                    capture, image_path, args.gemini_model, args.timeout, ident, objects
                )
            except Exception as exc:
                source_status["gemini"] = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
                errors.append({"source": "gemini", "error": source_status["gemini"]["error"]})

        # If no fresh call happened, use the newest existing box artifact for collection/SAM.
        if contract is None and semantic_allowed:
            existing = sorted(capture.glob("hazard_vlm_response_*_boxes_v0.json"), key=lambda p: p.stat().st_mtime)
            if existing:
                try:
                    import hazard_vlm_contract
                    contract = _read_json(existing[-1])
                    hazards = hazard_vlm_contract.parse_response(contract)
                    before = len(objects)
                    _collect_existing_artifact(existing[-1], identity=ident, hint="gemini", objects=objects, errors=errors)
                    source_status.setdefault("existing_gemini_artifact", {})
                    source_status["existing_gemini_artifact"] = {
                        "status": "collected",
                        "artifact": existing[-1].name,
                        "geometry_objects": len(objects) - before,
                    }
                except Exception as exc:
                    errors.append({"source": "existing_gemini_artifact", "error": f"{type(exc).__name__}: {exc}"})

        deps = bool(importlib.util.find_spec("torch") and importlib.util.find_spec("transformers"))
        if args.no_sam:
            source_status["sam2"] = {"status": "disabled-by-argument"}
        elif not semantic_allowed:
            source_status["sam2"] = {"status": "skipped-unconfirmed-heatmap-state"}
        elif not hazards:
            source_status["sam2"] = {"status": "skipped-no-semantic-objects"}
        elif not deps:
            source_status["sam2"] = {"status": "skipped-dependencies-not-present", "installer_action_taken": False}
        else:
            try:
                source_status["sam2"] = _fresh_sam(
                    capture, image_path, hazards, args.sam_model, args.gemini_model, ident, objects
                )
            except Exception as exc:
                source_status["sam2"] = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
                errors.append({"source": "sam2", "error": source_status["sam2"]["error"]})

        # Course archaeology is not re-run per tee.  If Step 3/4 artifacts were copied
        # into this capture (or supplied explicitly), collect them; Step 9 will cache
        # these by course/version/hash instead of doing course work every hole.
        extra_paths = [Path(x).expanduser() for x in args.extra_input]
        for name, hint in (("features.json", "gkd"), ("geometry_candidates.json", "unity")):
            p = capture / name
            if p.exists():
                extra_paths.append(p)
        seen: set[str] = set()
        collected_extra = []
        for path in extra_paths:
            try:
                resolved = path.resolve()
            except Exception:
                resolved = path
            key = str(resolved)
            if key in seen or not resolved.exists():
                continue
            seen.add(key)
            before = len(objects)
            hint = "gkd" if resolved.name == "features.json" else "unity" if "geometry" in resolved.name else None
            _collect_existing_artifact(resolved, identity=ident, hint=hint, objects=objects, errors=errors)
            collected_extra.append({"artifact": str(resolved), "geometry_objects": len(objects) - before})
        source_status["course_artifacts"] = {
            "status": "collected-if-present",
            "artifacts": collected_extra,
            "per_tee_course_analysis": False,
            "next": "Step 9 course/version/hash cache",
        }

        bundle = hg.bundle(objects, errors=errors)
        _atomic_json(bundle_path, bundle)
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "created_epoch": time.time(),
            "capture": capture.name,
            "identity": ident,
            "source_image_policy": image_policy,
            "strategy_authority": False,
            "failure_policy": "independent-source-log-and-continue",
            "watcher_blocking": False,
            "production_architecture": "field-lab-only; looper.golf remains hosted/no-required-local-companion",
            "source_status": source_status,
            "hazard_geometry_bundle": bundle_path.name,
            "object_count": bundle.get("object_count"),
            "class_counts": bundle.get("class_counts"),
            "source_counts": bundle.get("source_counts"),
            "adapter_errors": errors,
            "elapsed_seconds": time.perf_counter() - started,
        }
        _atomic_json(manifest_path, manifest)
        _update_hole_model(capture, manifest_path.name, bundle_path.name, source_status)
        print(
            f"Hazard field shadow complete | objects={bundle['object_count']} | "
            f"Gemini={source_status.get('gemini', {}).get('status')} | "
            f"SAM2={source_status.get('sam2', {}).get('status')} | strategy authority=OFF"
        )
        return 0
    except Exception as exc:
        failure = {
            "schema_version": SCHEMA_VERSION,
            "created_epoch": time.time(),
            "capture": capture.name,
            "status": "orchestrator-error",
            "error": f"{type(exc).__name__}: {exc}",
            "strategy_authority": False,
            "failure_policy": "non-blocking-field-shadow",
            "elapsed_seconds": time.perf_counter() - started,
        }
        try:
            capture.mkdir(parents=True, exist_ok=True)
            _atomic_json(manifest_path, failure)
        except Exception:
            pass
        print(f"Hazard field shadow error (non-blocking): {failure['error']}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
