#!/usr/bin/env python3
"""Run SAM2 against already-saved OpenAI Luna hazard boxes without another API call.

The 2026-09-11 Step 11 run already paid for and saved Luna semantic localization on
three valid FarmLinks tee captures. This replay consumes those exact contracts and
source images, runs only local prompt segmentation, merges accepted SAM2 geometry
into HazardGeometry v0, and records a separate replay status.

No OpenAI/Gemini request is made. No GSPro input is sent. Strategy authority remains off.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from typing import Any

import hazard_field_openai_enrich as enrich
import hazard_field_shadow as step8
import hazard_geometry_contract as hg
import hazard_vlm_contract

HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / "output"
DEFAULT_MODEL = "gpt-5.6-luna"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    tmp.replace(path)


def capture_dirs(root: Path) -> list[Path]:
    if root.is_dir() and root.name.startswith("tee_capture_"):
        return [root]
    try:
        rows = [p for p in root.glob("tee_capture_*") if p.is_dir()]
    except Exception:
        rows = []
    return sorted(rows, key=lambda p: p.stat().st_mtime)


def merge_unique(existing: list[dict[str, Any]], additions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    ordered: list[str] = []
    for item in [*existing, *additions]:
        gid = str(item.get("geometry_id") or "")
        if not gid:
            continue
        if gid not in by_id:
            ordered.append(gid)
        by_id[gid] = item
    return [by_id[gid] for gid in ordered]


def process_capture(capture: Path, model: str, sam_model: str) -> dict[str, Any]:
    started = time.perf_counter()
    slug = enrich._slug(model)
    contract_path = capture / f"hazard_vlm_response_openai_{slug}_v0.json"
    if not contract_path.is_file():
        raise RuntimeError(f"saved Luna contract missing: {contract_path.name}")
    model_path = capture / "hole_model.json"
    if not model_path.is_file():
        raise RuntimeError("hole_model.json missing")

    contract = read_json(contract_path)
    hazards = hazard_vlm_contract.parse_response(contract)
    hole_model = read_json(model_path)
    identity = enrich._identity(capture, hole_model)
    image_path, image_policy = step8._semantic_image(capture, hole_model)

    sam_objects, sam_status = enrich._sam_geometries(
        capture,
        image_path,
        hazards,
        model=sam_model,
        vlm_model=model,
        identity=identity,
    )
    if sam_status.get("status") != "complete":
        raise RuntimeError(f"SAM2 did not complete: {sam_status}")

    bundle_path = capture / "hazard_geometry_v0.json"
    existing = read_json(bundle_path) if bundle_path.is_file() else {"objects": [], "adapter_errors": []}
    combined = merge_unique(list(existing.get("objects") or []), sam_objects)
    bundle = hg.bundle(combined, errors=list(existing.get("adapter_errors") or []))
    write_json(bundle_path, bundle)

    manifest_path = capture / "hazard_field_shadow_v0.json"
    if manifest_path.is_file():
        manifest = read_json(manifest_path)
    else:
        manifest = {"source_status": {}, "strategy_authority": False}
    source_status = manifest.setdefault("source_status", {})
    openai_status = source_status.setdefault("openai_vlm", {})
    openai_status["sam2"] = {
        **sam_status,
        "replay_mode": "saved-luna-boxes-no-api-call",
        "source_contract": contract_path.name,
        "source_image": image_path.name,
        "image_policy": image_policy,
        "strategy_authority": False,
    }
    manifest["object_count"] = bundle.get("object_count")
    manifest["class_counts"] = bundle.get("class_counts")
    manifest["source_counts"] = bundle.get("source_counts")
    manifest["hazard_geometry_bundle"] = bundle_path.name
    manifest["strategy_authority"] = False
    write_json(manifest_path, manifest)

    return {
        "capture": capture.name,
        "source_contract": contract_path.name,
        "source_image": image_path.name,
        "hazard_count": len(hazards),
        "sam2_status": sam_status.get("status"),
        "sam2_model": sam_status.get("model"),
        "sam2_device": sam_status.get("device"),
        "sam2_latency_seconds": sam_status.get("latency_seconds"),
        "sam2_input_objects": sam_status.get("input_objects"),
        "sam2_accepted_masks": sam_status.get("accepted_masks"),
        "sam2_geometry_objects": len(sam_objects),
        "bundle_object_count": bundle.get("object_count"),
        "elapsed_seconds": time.perf_counter() - started,
        "strategy_authority": False,
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Replay saved Luna boxes through local SAM2")
    p.add_argument("--output-root", default=str(DEFAULT_OUTPUT))
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--latest", type=int, default=4)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--sam-model", default="facebook/sam2.1-hiera-tiny")
    p.add_argument("--summary-out")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.output_root).expanduser().resolve()
    captures = [Path(x).expanduser().resolve() for x in args.capture_dir]
    if not captures:
        candidates = capture_dirs(root)
        slug = enrich._slug(args.model)
        captures = [p for p in candidates if (p / f"hazard_vlm_response_openai_{slug}_v0.json").is_file()]
        captures = captures[-max(1, int(args.latest)):]
    if not captures:
        print("No tee captures with saved Luna contracts found.")
        return 1

    print("Looper Luna -> SAM2 saved-box replay")
    print("API calls: NONE | GSPro actuation: NONE | Strategy authority: OFF")
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for capture in captures:
        try:
            row = process_capture(capture, args.model, args.sam_model)
            rows.append(row)
            print(
                f"PASS {capture.name} | SAM {row['sam2_accepted_masks']}/{row['sam2_input_objects']} "
                f"| {row['sam2_latency_seconds']}s | bundle={row['bundle_object_count']}"
            )
        except Exception as exc:
            errors.append({"capture": str(capture), "error": f"{type(exc).__name__}: {exc}"})
            print(f"FAIL {capture.name} | {type(exc).__name__}: {exc}")

    summary = {
        "schema_version": "looper-luna-sam2-saved-replay-v0",
        "model": args.model,
        "sam_model": args.sam_model,
        "successes": len(rows),
        "failures": len(errors),
        "rows": rows,
        "errors": errors,
        "api_calls": 0,
        "gspro_actuation": false if False else False,
        "strategy_authority": False,
    }
    summary_path = Path(args.summary_out).expanduser().resolve() if args.summary_out else root / "hazard_luna_sam2_saved_replay_v0.json"
    write_json(summary_path, summary)
    print(f"Summary: {summary_path}")
    return 0 if rows and not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
