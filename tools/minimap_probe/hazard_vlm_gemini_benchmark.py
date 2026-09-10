#!/usr/bin/env python3
"""Run a small Gemini-vs-Gemini hazard benchmark over saved tee captures."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

import hazard_vlm_gemini
import hazard_vlm_shadow

DEFAULT_MODELS = ["gemini-3.7-flash", "gemini-3.1-flash-lite"]


def _has_image(capture: Path) -> bool:
    try:
        hazard_vlm_shadow._resolve_image(capture)
        return True
    except Exception:
        return False


def parse_args():
    p = argparse.ArgumentParser(
        description="Benchmark Gemini hazard VLMs on saved Looper tee captures"
    )
    p.add_argument("--output-root", required=True)
    p.add_argument("--latest", type=int, default=5)
    p.add_argument("--models", default=",".join(DEFAULT_MODELS))
    p.add_argument("--repeats", type=int, default=1)
    p.add_argument("--timeout-seconds", type=float, default=90.0)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.output_root)
    models = [x.strip() for x in args.models.split(",") if x.strip()]
    captures = sorted(
        [p for p in root.glob("tee_capture_*") if p.is_dir() and _has_image(p)],
        key=lambda p: p.stat().st_mtime,
    )
    if args.latest > 0:
        captures = captures[-args.latest:]
    if not captures:
        raise RuntimeError(f"No tee captures with minimap images under {root}")

    rows = []
    print(
        f"Gemini hazard benchmark: {len(captures)} captures x "
        f"{len(models)} models x {args.repeats} repeat(s)"
    )
    for capture in captures:
        for model in models:
            for repeat in range(1, args.repeats + 1):
                started = time.perf_counter()
                row = {
                    "capture": capture.name,
                    "model": model,
                    "repeat": repeat,
                    "status": "error",
                    "error": None,
                }
                try:
                    payload = hazard_vlm_gemini.analyze_capture(
                        capture,
                        model=model,
                        timeout_seconds=args.timeout_seconds,
                    )
                    row.update({
                        "status": "ok",
                        "latency_seconds": payload.get("latency_seconds"),
                        "hazard_counts": payload.get("hazard_counts"),
                        "usage_metadata": payload.get("usage_metadata"),
                        "provider_raw_artifact": payload.get("provider_raw_artifact"),
                        "response_artifact": payload.get("response_artifact"),
                        "native_overlay_artifact": payload.get("native_overlay_artifact"),
                        "cv_refined_overlay_artifact": payload.get("cv_refined_overlay_artifact"),
                        "result_artifact": payload.get("result_artifact"),
                    })
                    c = row["hazard_counts"] or {}
                    print(
                        f"OK {capture.name} | {model} | r{repeat} | "
                        f"B={c.get('bunker')} W={c.get('water')} "
                        f"U={c.get('uncertain')} | "
                        f"{row.get('latency_seconds'):.2f}s"
                    )
                except Exception as exc:
                    row["error"] = str(exc)
                    row["latency_seconds"] = time.perf_counter() - started
                    print(f"ERR {capture.name} | {model} | r{repeat} | {exc}")
                rows.append(row)

    summary = {
        "schema_version": "looper-hazard-vlm-gemini-benchmark-v0",
        "created_epoch": time.time(),
        "strategy_authority": False,
        "output_root": str(root),
        "captures": [p.name for p in captures],
        "models": models,
        "repeats": args.repeats,
        "runs": rows,
        "successes": sum(1 for row in rows if row["status"] == "ok"),
        "failures": sum(1 for row in rows if row["status"] != "ok"),
    }
    out = root / "hazard_vlm_gemini_benchmark_v0.json"
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print()
    print(f"Benchmark JSON: {out}")
    print(
        "Review hazard_vlm_native_overlay_*.png for Gemini's own localization, "
        "then hazard_vlm_overlay_*.png for the local CV-refined version."
    )
    return 0 if summary["successes"] > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
