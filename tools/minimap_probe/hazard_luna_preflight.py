#!/usr/bin/env python3
"""No-GSPro preflight for Looper Step 11 Luna hazard field testing.

Uses one replayable saved tee minimap and the same OpenAI provider adapter as live
Luna enrichment. It never actuates GSPro, writes strategy state, or promotes hazard
geometry. Exit 0 means the Luna credential/model/image path is ready for field use.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time
from typing import Any

import hazard_field_shadow as step8
import hazard_vlm_contract
import hazard_vlm_provider


REQUIRED_LIVE_FILES = (
    "hazard_field_shadow_luna_cached.py",
    "hazard_field_openai_enrich.py",
    "hazard_vlm_provider.py",
    "hazard_vlm_openai.py",
)


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _candidate_capture_dirs(root: Path, explicit: str | None) -> list[Path]:
    if explicit:
        return [Path(explicit).expanduser().resolve()]
    rows = [p for p in root.glob("tee_capture_*") if p.is_dir()]
    rows.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return rows


def _pick_replayable_capture(
    root: Path,
    explicit: str | None,
    allow_unconfirmed: bool,
) -> tuple[Path, Path, dict[str, Any]]:
    problems: list[str] = []
    for capture in _candidate_capture_dirs(root, explicit):
        model_path = capture / "hole_model.json"
        if not model_path.is_file():
            problems.append(f"{capture.name}: hole_model.json missing")
            continue
        try:
            model = _read(model_path)
            image_path, image_policy = step8._semantic_image(capture, model)
        except Exception as exc:
            problems.append(f"{capture.name}: {type(exc).__name__}: {exc}")
            continue
        if not image_policy.get("confirmed_heatmap_off") and not allow_unconfirmed:
            problems.append(f"{capture.name}: heatmap-off state unconfirmed")
            continue
        return capture, image_path, image_policy

    detail = "; ".join(problems[:5]) or "no tee_capture_* folders found"
    raise RuntimeError(f"No replayable saved tee capture is ready: {detail}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Looper Luna Step 11 no-GSPro preflight")
    p.add_argument(
        "--output-root",
        default=str(Path(__file__).resolve().parent / "output"),
    )
    p.add_argument("--capture-dir")
    p.add_argument("--model", default=hazard_vlm_provider.DEFAULT_OPENAI_MODEL)
    p.add_argument("--timeout-seconds", type=float, default=60.0)
    p.add_argument("--allow-unconfirmed-semantic-image", action="store_true")
    p.add_argument("--json", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    here = Path(__file__).resolve().parent
    started = time.perf_counter()
    result: dict[str, Any] = {
        "ready": False,
        "provider": "openai",
        "model": args.model,
        "strategy_authority": False,
        "gspro_actuation": False,
    }

    try:
        missing = [name for name in REQUIRED_LIVE_FILES if not (here / name).is_file()]
        if missing:
            raise RuntimeError(f"required Luna live files missing: {', '.join(missing)}")
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set in this process")

        root = Path(args.output_root).expanduser().resolve()
        capture, image_path, image_policy = _pick_replayable_capture(
            root,
            args.capture_dir,
            args.allow_unconfirmed_semantic_image,
        )

        contract, meta, _raw = hazard_vlm_provider.call_provider(
            image_path=image_path,
            provider="openai",
            model=args.model,
            timeout_seconds=args.timeout_seconds,
        )
        hazards = hazard_vlm_contract.parse_response(contract)

        result.update(
            {
                "ready": True,
                "capture": capture.name,
                "source_image": image_path.name,
                "image_policy": image_policy,
                "hazard_count": len(hazards),
                "hazard_counts": meta.get("hazard_counts") or {},
                "provider_latency_seconds": meta.get("latency_seconds"),
                "elapsed_seconds": time.perf_counter() - started,
            }
        )
    except Exception as exc:
        result.update(
            {
                "error": f"{type(exc).__name__}: {exc}",
                "elapsed_seconds": time.perf_counter() - started,
            }
        )

    if args.json:
        print(json.dumps(result, indent=2, default=str))
    elif result["ready"]:
        print("LUNA STEP 11 PREFLIGHT: PASS")
        print(
            f"Saved capture: {result.get('capture')} | image={result.get('source_image')} | "
            f"model={result.get('model')} | hazards={result.get('hazard_count')} | "
            f"provider_latency={float(result.get('provider_latency_seconds') or 0):.2f}s"
        )
        print("GSPro actuation: NONE | Strategy authority: OFF")
    else:
        print("LUNA STEP 11 PREFLIGHT: FAIL")
        print(result.get("error") or "unknown preflight error")
        print("Do not count the next holes as Luna Step 11 validation until this passes.")

    return 0 if result["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
