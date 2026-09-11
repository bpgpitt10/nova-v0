#!/usr/bin/env python3
"""Luna-first benchmark for Looper hazard VLM flow.

Runs saved tee captures through provider-neutral semantic localization, validates the
Looper contract, performs the existing local refinement, and writes a compact report.
Nothing here can influence live strategy.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
import time
from typing import Any

import cv2

import hazard_vlm_contract
import hazard_vlm_provider
import hazard_vlm_refine
import hazard_vlm_shadow

SCHEMA_VERSION = "looper-hazard-vlm-provider-benchmark-v0"


def _slug(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in value)


def _captures(root: Path, latest: int) -> list[Path]:
    rows = [p for p in root.glob("tee_capture_*") if p.is_dir()]
    rows.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return rows[:max(1, int(latest))]


def _write(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")


def run_capture(
    capture: Path,
    *,
    timeout_seconds: float,
    gemini_fallback: bool,
) -> dict[str, Any]:
    image_path = hazard_vlm_shadow._resolve_image(capture)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {image_path}")

    chain = [("openai", hazard_vlm_provider.DEFAULT_OPENAI_MODEL)]
    if gemini_fallback:
        chain.append(("gemini", hazard_vlm_provider.DEFAULT_GEMINI_MODEL))

    started = time.perf_counter()
    contract, meta, raw, attempts = hazard_vlm_provider.call_chain(
        image_path=image_path,
        providers=chain,
        timeout_seconds=timeout_seconds,
    )
    hazards = hazard_vlm_contract.parse_response(contract)
    provider = str(meta.get("provider") or "unknown")
    model = str(meta.get("model") or "unknown")
    slug = f"{_slug(provider)}_{_slug(model)}"

    response_path = capture / f"hazard_vlm_response_{slug}_v0.json"
    raw_path = capture / f"hazard_vlm_provider_raw_{slug}_v0.json"
    meta_path = capture / f"hazard_vlm_meta_{slug}_v0.json"
    _write(response_path, contract)
    _write(raw_path, raw)
    _write(meta_path, meta)

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

    return {
        "capture": capture.name,
        "source_image": image_path.name,
        "status": "complete",
        "provider": provider,
        "model": model,
        "elapsed_seconds": time.perf_counter() - started,
        "hazard_counts": meta.get("hazard_counts") or {},
        "usage_metadata": meta.get("usage_metadata") or {},
        "provider_attempts": attempts,
        "response_artifact": response_path.name,
        "overlay_artifact": overlay_path.name,
        "refined_object_count": len(refined),
        "strategy_authority": False,
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Benchmark Luna on saved Looper tee minimaps")
    p.add_argument("--output-root", default=str(Path(__file__).resolve().parent / "output"))
    p.add_argument("--latest", type=int, default=5)
    p.add_argument("--repeats", type=int, default=1)
    p.add_argument("--timeout-seconds", type=float, default=60.0)
    p.add_argument("--gemini-fallback", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.output_root).expanduser().resolve()
    captures = _captures(root, args.latest)
    rows: list[dict[str, Any]] = []
    for repeat in range(1, max(1, int(args.repeats)) + 1):
        for capture in captures:
            print(f"[{repeat}/{args.repeats}] Luna hazard read: {capture.name}")
            try:
                row = run_capture(
                    capture,
                    timeout_seconds=args.timeout_seconds,
                    gemini_fallback=args.gemini_fallback,
                )
            except Exception as exc:
                row = {
                    "capture": capture.name,
                    "status": "error",
                    "error": f"{type(exc).__name__}: {exc}",
                    "strategy_authority": False,
                }
            row["repeat"] = repeat
            rows.append(row)
            print(f"  -> {row.get('status')} | {row.get('provider', 'none')} {row.get('model', '')}")

    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    report = {
        "schema_version": SCHEMA_VERSION,
        "created_epoch": time.time(),
        "primary_provider": "openai",
        "primary_model": hazard_vlm_provider.DEFAULT_OPENAI_MODEL,
        "gemini_fallback_enabled": bool(args.gemini_fallback),
        "capture_count": len(captures),
        "attempt_count": len(rows),
        "complete_count": sum(row.get("status") == "complete" for row in rows),
        "error_count": sum(row.get("status") != "complete" for row in rows),
        "rows": rows,
        "strategy_authority": False,
        "promotion_decision": "none",
    }
    path = root / f"hazard_vlm_provider_benchmark_{stamp}.json"
    _write(path, report)
    print(f"Benchmark report: {path}")
    print("Strategy authority: OFF | Promotion: NONE")
    return 0 if report["complete_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
