#!/usr/bin/env python3
"""Apply provider defaults to imported course configs without overriding explicit terrain settings."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

TERRAIN_DEFAULTS: dict[str, dict[str, Any]] = {
    "us": {
        "provider": "usgs-3dep-1m",
        "maxSourceResolutionMeters": 1.1,
        "sourceMarginMeters": 300,
        "runtimeSpacingYards": 10,
        "gridPaddingYards": 0,
        "routeProbeSpacingYards": 10,
        "maxGridNoDataFraction": 0.35,
    },
    "ca": {
        "provider": "nrcan-hrdem-lidar",
        "maxSourceResolutionMeters": 2.1,
        "sourceMarginMeters": 300,
        "runtimeSpacingYards": 10,
        "gridPaddingYards": 0,
        "routeProbeSpacingYards": 10,
        "maxGridNoDataFraction": 0.45,
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed-file", required=True, type=Path)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit(f"{path}: expected JSON object")
    return payload


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    seed_file = args.seed_file.resolve()
    seeds = load_json(seed_file).get("courses")
    if not isinstance(seeds, list) or not seeds:
        raise SystemExit(f"{seed_file}: courses must be a non-empty array")

    updated = 0
    preserved = 0
    missing = 0

    for seed in seeds:
        if not isinstance(seed, dict):
            raise SystemExit(f"{seed_file}: every course seed must be an object")
        slug = seed.get("slug")
        country_code = str(seed.get("countryCode") or "").strip().lower()
        if not isinstance(slug, str) or not slug:
            raise SystemExit(f"{seed_file}: every course seed requires slug")

        config_path = repo_root / "config" / "course-geometry" / f"{slug}-v1.json"
        if not config_path.exists():
            missing += 1
            print(f"{slug}: config not generated yet; terrain defaults deferred")
            continue

        config = load_json(config_path)
        if isinstance(config.get("terrain"), dict):
            preserved += 1
            print(f"{slug}: explicit terrain config preserved")
            continue

        terrain = TERRAIN_DEFAULTS.get(country_code)
        if terrain is None:
            raise SystemExit(
                f"{slug}: no generic terrain default for countryCode={country_code!r}; "
                "add an explicit terrain config or supported country default"
            )

        config["terrain"] = dict(terrain)
        config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        updated += 1
        print(f"{slug}: applied {terrain['provider']} terrain defaults")

    print(
        f"terrain defaults complete: updated={updated} preserved={preserved} missing={missing}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
