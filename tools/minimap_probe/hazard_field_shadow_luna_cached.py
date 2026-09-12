#!/usr/bin/env python3
"""Run validated Step 8/9 collection, then enrich the capture with Luna semantics.

The base collector is intentionally reused unchanged with Gemini/SAM disabled. After
its cache work completes, its manifest is staged aside while the OpenAI enrichment
runs. The final manifest name is restored only after enrichment completes/fails soft,
so Step 11's settle check does not package a half-enriched capture.

For the simulator field build, finish by materializing `hazard_map_shadow_v0.json`.
That gives the live status monitor one stable, source-aware artifact to consume while
keeping strategy authority OFF.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys


def parse_args() -> tuple[argparse.Namespace, list[str]]:
    p = argparse.ArgumentParser(description="Looper Luna Step 8/9 hazard wrapper", add_help=True)
    p.add_argument("--capture-dir", required=True)
    p.add_argument("--luna-model", default="gpt-5.6-luna")
    p.add_argument("--luna-timeout", type=float, default=60.0)
    p.add_argument("--no-luna-sam", action="store_true")
    p.add_argument("--allow-unconfirmed-semantic-image", action="store_true")
    return p.parse_known_args()


def main() -> int:
    args, passthrough = parse_args()
    here = Path(__file__).resolve().parent
    capture = Path(args.capture_dir).expanduser().resolve()
    cached = here / "hazard_field_shadow_cached.py"
    enrich = here / "hazard_field_openai_enrich.py"
    map_builder = here / "hazard_map_shadow.py"

    base_command = [
        sys.executable,
        str(cached),
        "--capture-dir",
        str(capture),
        "--no-gemini",
        "--no-sam",
        *passthrough,
    ]
    try:
        base = subprocess.run(base_command, cwd=str(here), check=False)
        base_returncode = base.returncode
    except Exception as exc:
        print(f"Luna wrapper could not launch base Step 8/9 collector (non-blocking): {exc}")
        return 0

    final_manifest = capture / "hazard_field_shadow_v0.json"
    base_manifest = capture / "hazard_field_shadow_base_v0.json"
    try:
        if final_manifest.is_file():
            if base_manifest.exists():
                base_manifest.unlink()
            final_manifest.replace(base_manifest)
    except Exception as exc:
        print(f"Luna wrapper could not stage base manifest (non-blocking): {exc}")

    enrich_command = [
        sys.executable,
        str(enrich),
        "--capture-dir",
        str(capture),
        "--model",
        args.luna_model,
        "--timeout",
        str(args.luna_timeout),
    ]
    if args.no_luna_sam:
        enrich_command.append("--no-sam")
    if args.allow_unconfirmed_semantic_image:
        enrich_command.append("--allow-unconfirmed-semantic-image")

    try:
        subprocess.run(enrich_command, cwd=str(here), check=False)
    except Exception as exc:
        print(f"Luna enrichment launch failed (non-blocking): {exc}")

    # Never leave Step 11 waiting forever. If enrichment failed before writing the
    # final manifest, restore the completed base manifest as explicit fail-soft data.
    try:
        if not final_manifest.is_file() and base_manifest.is_file():
            base_manifest.replace(final_manifest)
    except Exception:
        pass

    # Materialize the canonical shadow map after the final geometry bundle settles.
    # This is deliberately fail-soft and never grants strategy authority.
    try:
        bundle = capture / "hazard_geometry_v0.json"
        if bundle.is_file() and map_builder.is_file():
            completed = subprocess.run(
                [sys.executable, str(map_builder), "--capture-dir", str(capture)],
                cwd=str(here),
                check=False,
                capture_output=True,
                text=True,
                timeout=30.0,
            )
            if completed.returncode != 0:
                print(
                    "HazardMap shadow build failed non-blocking: "
                    + ((completed.stderr or completed.stdout or "unknown error")[-800:])
                )
    except Exception as exc:
        print(f"HazardMap shadow build failed non-blocking: {exc}")

    return base_returncode


if __name__ == "__main__":
    raise SystemExit(main())
