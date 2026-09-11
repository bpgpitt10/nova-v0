#!/usr/bin/env python3
"""Luna enrichment for an existing Step 8/9 hazard field capture.

Runs only after the validated Step 8/9 collector has finished. It adds OpenAI Luna
semantic localization, local CV refinement, and SAM2 prompt segmentation when those
optional dependencies are already installed. It never grants strategy authority.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import time
from typing import Any

import cv2

import hazard_field_shadow as step8
import hazard_geometry_contract as hg
import hazard_vlm_contract
import hazard_vlm_provider
import hazard_vlm_shadow

SCHEMA_VERSION = "looper-hazard-openai-field-enrich-v0"
DEFAULT_MODEL = hazard_vlm_provider.DEFAULT_OPENAI_MODEL
DEFAULT_SAM_MODEL = step8.DEFAULT_SAM_MODEL


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    temp.replace(path)


def _slug(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in value)


def _base_manifest_path(capture: Path) -> Path:
    base = capture / "hazard_field_shadow_base_v0.json"
    return base if base.is_file() else capture / "hazard_field_shadow_v0.json"


def _attach_status(capture: Path, status: dict[str, Any]) -> None:
    source = _base_manifest_path(capture)
    manifest = _read(source) if source.is_file() else {
        "schema_version": step8.SCHEMA_VERSION,
        "created_epoch": time.time(),
        "capture": capture.name,
        "strategy_authority": False,
        "source_status": {},
        "adapter_errors": [],
    }
    manifest.setdefault("source_status", {})["openai_vlm"] = status
    manifest["openai_enrichment"] = {
        "schema_version": SCHEMA_VERSION,
        "strategy_authority": False,
        "finished_epoch": time.time(),
    }
    _write(capture / "hazard_field_shadow_v0.json", manifest)

    model_path = capture / "hole_model.json"
    if model_path.is_file():
        try:
            model = _read(model_path)
            field = model.setdefault("hazards", {}).setdefault("field_shadow", {})
            field.setdefault("source_status", {})["openai_vlm"] = status
            field["strategy_authority"] = False
            _write(model_path, model)
        except Exception:
            pass


def _identity(capture: Path, model: dict[str, Any]) -> dict[str, Any]:
    context = None
    context_path = capture / "capture_context.json"
    if context_path.is_file():
        try:
            context = _read(context_path)
        except Exception:
            context = None
    return step8._identity(capture, model, context)


def _provider_geometries(contract: dict[str, Any], *, artifact: str, identity: dict[str, Any], model: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in hazard_vlm_contract.parse_response(contract):
        rows.append(hg.from_vlm_hazard(
            {
                "hazard_id": item.hazard_id,
                "hazard_class": item.hazard_class,
                "confidence": item.confidence,
                "bbox_norm": list(item.bbox_norm),
                "note": item.note,
            },
            source_kind="vlm",
            source_name=f"OpenAI {model}",
            artifact=artifact,
            identity=identity,
        ))
    return rows


def _refined_geometries(shadow: dict[str, Any], *, artifact: str, identity: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in shadow.get("objects") or []:
        if not isinstance(item, dict):
            continue
        try:
            rows.append(hg.from_refined_vlm_object(item, artifact=artifact, identity=identity))
        except Exception:
            pass
    return rows


def _sam_geometries(
    capture: Path,
    image_path: Path,
    hazards: list[Any],
    *,
    model: str,
    vlm_model: str,
    identity: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    deps = bool(importlib.util.find_spec("torch") and importlib.util.find_spec("transformers"))
    if not deps:
        return [], {"status": "skipped-dependencies-not-present", "installer_action_taken": False}
    try:
        import hazard_prompt_segment

        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"could not read {image_path}")
        backend = hazard_prompt_segment.Sam2TransformersBackend(model, "auto")
        payload = hazard_prompt_segment.segment_hazards(image, hazards, backend)
        prefix = f"hazard_sam2_{_slug(vlm_model)}"
        artifacts = hazard_prompt_segment.save_artifacts(capture, image, payload, prefix=prefix)
        geometries: list[dict[str, Any]] = []
        for row in payload.get("objects") or []:
            if not isinstance(row, dict):
                continue
            mask_ref = None
            if row.get("segmentation_status") == "accepted":
                safe_id = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in str(row.get("hazard_id") or "hazard"))
                mask_ref = f"{artifacts['mask_dir']}/{safe_id}.png"
            try:
                geometries.append(hg.from_sam_object(
                    row,
                    source_name=f"SAM2 {model} prompted by OpenAI {vlm_model}",
                    artifact=artifacts["result"],
                    mask_artifact=mask_ref,
                    identity=identity,
                ))
            except Exception:
                pass
        return geometries, {
            "status": "complete",
            "model": model,
            "device": payload.get("device"),
            "latency_seconds": payload.get("latency_seconds"),
            "input_objects": payload.get("object_count"),
            "accepted_masks": payload.get("accepted_count"),
            "geometry_objects": len(geometries),
            "artifacts": artifacts,
        }
    except Exception as exc:
        return [], {"status": "error", "error": f"{type(exc).__name__}: {exc}"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Enrich Step 8/9 capture with Luna hazard semantics")
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--sam-model", default=DEFAULT_SAM_MODEL)
    p.add_argument("--timeout", type=float, default=60.0)
    p.add_argument("--no-sam", action="store_true")
    p.add_argument("--allow-unconfirmed-semantic-image", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    capture = Path(args.capture_dir).expanduser().resolve()
    started = time.perf_counter()
    status: dict[str, Any] = {
        "status": "starting",
        "provider": "openai",
        "model": args.model,
        "strategy_authority": False,
    }
    try:
        if not capture.is_dir():
            raise RuntimeError(f"capture directory missing: {capture}")
        if not os.environ.get("OPENAI_API_KEY"):
            status.update({"status": "skipped-no-api-key", "elapsed_seconds": time.perf_counter() - started})
            _attach_status(capture, status)
            print("OpenAI hazard enrichment skipped: OPENAI_API_KEY missing")
            return 0

        model_path = capture / "hole_model.json"
        if not model_path.is_file():
            raise RuntimeError("hole_model.json missing")
        model = _read(model_path)
        identity = _identity(capture, model)
        image_path, image_policy = step8._semantic_image(capture, model)
        semantic_allowed = bool(image_policy["confirmed_heatmap_off"] or args.allow_unconfirmed_semantic_image)
        if not semantic_allowed:
            status.update({
                "status": "skipped-unconfirmed-heatmap-state",
                "source_image": image_path.name,
                "elapsed_seconds": time.perf_counter() - started,
            })
            _attach_status(capture, status)
            print("OpenAI hazard enrichment skipped: heatmap-off state unconfirmed")
            return 0

        contract, meta, raw = hazard_vlm_provider.call_provider(
            image_path=image_path,
            provider="openai",
            model=args.model,
            timeout_seconds=args.timeout,
        )
        slug = _slug(args.model)
        response_path = capture / f"hazard_vlm_response_openai_{slug}_v0.json"
        raw_path = capture / f"hazard_vlm_provider_raw_openai_{slug}_v0.json"
        meta_path = capture / f"hazard_vlm_meta_openai_{slug}_v0.json"
        _write(response_path, contract)
        _write(raw_path, raw)
        _write(meta_path, meta)

        # Reuse the provider-neutral local refinement path already validated by the
        # replay benchmark. Its generic artifact names are safe because Gemini was
        # disabled by the Luna wrapper for this capture.
        shadow = hazard_vlm_shadow.run_capture(capture, response_path)
        hazards = hazard_vlm_contract.parse_response(contract)

        additions = _provider_geometries(
            contract, artifact=response_path.name, identity=identity, model=args.model
        )
        additions += _refined_geometries(
            shadow, artifact="hazard_vlm_shadow_v0.json", identity=identity
        )

        if args.no_sam or not hazards:
            sam_objects: list[dict[str, Any]] = []
            sam_status = {"status": "disabled-or-no-semantic-objects"}
        else:
            sam_objects, sam_status = _sam_geometries(
                capture,
                image_path,
                hazards,
                model=args.sam_model,
                vlm_model=args.model,
                identity=identity,
            )
        additions += sam_objects

        bundle_path = capture / "hazard_geometry_v0.json"
        existing = _read(bundle_path) if bundle_path.is_file() else {
            "objects": [], "adapter_errors": []
        }
        merged = hg.bundle(
            list(existing.get("objects") or []) + additions,
            errors=list(existing.get("adapter_errors") or []),
        )
        _write(bundle_path, merged)

        status.update({
            "status": "complete",
            "source_image": image_path.name,
            "image_policy": image_policy,
            "hazard_counts": meta.get("hazard_counts") or {},
            "usage_metadata": meta.get("usage_metadata") or {},
            "provider_latency_seconds": meta.get("latency_seconds"),
            "local_refined_objects": len(shadow.get("objects") or []),
            "sam2": sam_status,
            "geometry_objects_added": len(additions),
            "artifacts": [response_path.name, raw_path.name, meta_path.name, "hazard_vlm_shadow_v0.json"],
            "elapsed_seconds": time.perf_counter() - started,
        })
        _attach_status(capture, status)

        # Refresh manifest counts after merging Luna/refinement/SAM geometry.
        final_manifest = capture / "hazard_field_shadow_v0.json"
        if final_manifest.is_file():
            manifest = _read(final_manifest)
            manifest["object_count"] = merged.get("object_count")
            manifest["class_counts"] = merged.get("class_counts")
            manifest["source_counts"] = merged.get("source_counts")
            manifest["adapter_errors"] = merged.get("adapter_errors")
            manifest["hazard_geometry_bundle"] = bundle_path.name
            _write(final_manifest, manifest)

        print(
            f"OpenAI hazard enrichment complete | model={args.model} | "
            f"objects_added={len(additions)} | SAM2={sam_status.get('status')} | strategy authority=OFF"
        )
        return 0
    except Exception as exc:
        status.update({
            "status": "error",
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_seconds": time.perf_counter() - started,
        })
        try:
            _attach_status(capture, status)
        except Exception:
            pass
        print(f"OpenAI hazard enrichment error (non-blocking): {status['error']}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
