#!/usr/bin/env python3
"""One-shot canonical Looper course importer.

A successful run produces, in one transaction:
- fresh exact-boundary OSM snapshot
- V7 static golf geometry and route diagnostics
- automatic whole-hole bare-earth terrain
- automatic ESA WorldCover context fill
- high-resolution green-detail sampled from the same DEM
- cache/provenance refresh
- a completion record in the validation manifest

The importer is intentionally fail-closed: unless explicitly waived in course
config, missing terrain/context/green inputs fail the import rather than leaving
a silently partial course for a second pass.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def run(*args: str) -> None:
    command = [sys.executable, *args]
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def worldcover_url(config: dict[str, Any]) -> str:
    landcover = config.get("landcoverContext") or {}
    explicit = str(landcover.get("sourceUrl") or "").strip()
    if explicit:
        return explicit
    center = config.get("osmCenter") or []
    if len(center) < 2:
        raise SystemExit("Automatic WorldCover requires config.osmCenter or landcoverContext.sourceUrl")
    lat = float(center[0])
    lon = float(center[1])
    lat0 = math.floor(lat / 3.0) * 3
    lon0 = math.floor(lon / 3.0) * 3
    tile = f"{'N' if lat0 >= 0 else 'S'}{abs(lat0):02d}{'E' if lon0 >= 0 else 'W'}{abs(lon0):03d}"
    return (
        "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
        f"ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--reason", default="canonical-one-shot-import")
    args = parser.parse_args()

    config_path = (ROOT / args.config).resolve() if not args.config.is_absolute() else args.config
    config = read_json(config_path)
    if config.get("schemaVersion") != "looper-course-build-config-v1":
        raise SystemExit("Unsupported course build config schema")
    slug = args.slug
    course_id = config.get("courseId")
    if not isinstance(course_id, str) or not course_id:
        raise SystemExit("Course config is missing courseId")

    terrain_cfg = config.get("terrain") or {}
    terrain_enabled = terrain_cfg.get("enabled", True) is not False
    terrain_provider = str(terrain_cfg.get("provider") or "usgs-3dep")
    terrain_resolution = float(terrain_cfg.get("resolutionMeters") or 1.0)
    terrain_spacing = float(terrain_cfg.get("runtimeSpacingYards") or 10.0)

    landcover_cfg = config.get("landcoverContext") or {}
    landcover_enabled = landcover_cfg.get("enabled", True) is not False

    green_cfg = config.get("greenTerrain") or {}
    green_enabled = green_cfg.get("enabled", True) is not False
    green_spacing = float(green_cfg.get("spacingYards") or 1.0)
    green_margin = float(green_cfg.get("marginYards") or 12.0)

    artifact_dir = ROOT / "artifacts" / "course-geometry" / slug
    public_dir = ROOT / "public" / "course-geometry" / slug
    work_dir = ROOT / ".tmp" / "course-import" / slug
    artifact_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    snapshot = artifact_dir / "osm-snapshot.json"
    manifest = artifact_dir / "validation-v1.json"
    geometry = work_dir / "geometry.json"
    dem = work_dir / "course-dem.tif"
    dem_metadata = artifact_dir / "dem-source-v1.json"
    terrain_package = work_dir / "terrain.json"
    compose_report = artifact_dir / "terrain-compose-v1.json"
    final_package = public_dir / "course-v1.json"
    landcover_audit = artifact_dir / "worldcover-context-audit-v1.json"
    green_detail = public_dir / "green-detail-v1.json"
    cache = artifact_dir / "cache-v1.json"

    # 1. Fresh source geometry.
    run("tools/fetch_osm_course_snapshot_core.py", "--config", str(config_path), "--output", str(snapshot))
    run("tools/diagnose_course_route_orientation.py", "--osm", str(snapshot))
    run(
        "tools/build_osm_course_package_canonical.py",
        "--osm", str(snapshot),
        "--config", str(config_path),
        "--output", str(geometry),
        "--manifest", str(manifest),
    )

    # 2. Whole-hole terrain from an automatically acquired DEM.
    if terrain_enabled:
        if terrain_provider != "usgs-3dep":
            raise SystemExit(f"Unsupported automatic terrain provider: {terrain_provider!r}")
        run(
            "tools/fetch_course_dem.py",
            "--course-package", str(geometry),
            "--output", str(dem),
            "--metadata", str(dem_metadata),
            "--provider", terrain_provider,
            "--resolution-meters", str(terrain_resolution),
        )
        run(
            "tools/build_course_terrain.py",
            "--course-package", str(geometry),
            "--dem", str(dem),
            "--source-metadata", str(dem_metadata),
            "--output", str(terrain_package),
            "--spacing-yards", str(terrain_spacing),
        )
        run(
            "tools/compose_course_package_canonical.py",
            "--geometry", str(geometry),
            "--terrain", str(terrain_package),
            "--output", str(final_package),
            "--report", str(compose_report),
        )
    else:
        final_package.write_bytes(geometry.read_bytes())
        dem_metadata.unlink(missing_ok=True)
        compose_report.unlink(missing_ok=True)

    # 3. Context completion. WorldCover only fills unmapped context and never
    # manufactures playable/hazard surfaces.
    if landcover_enabled:
        run(
            "tools/enrich_worldcover_context.py",
            "--package", str(final_package),
            "--output", str(final_package),
            "--audit", str(landcover_audit),
            "--source-url", worldcover_url(config),
        )
    else:
        landcover_audit.unlink(missing_ok=True)

    # 4. Green terrain uses the exact same DEM as whole-hole terrain so there is
    # one elevation authority and no second source-selection pass.
    if green_enabled:
        if not terrain_enabled or not dem.exists():
            raise SystemExit("greenTerrain requires canonical terrain DEM; do not configure green terrain as a separate pass")
        source_meta = read_json(dem_metadata)
        run(
            "tools/build_course_green_detail.py",
            "--course-package", str(final_package),
            "--dem", str(dem),
            "--output", str(green_detail),
            "--spacing-yards", str(green_spacing),
            "--margin-yards", str(green_margin),
            "--dataset-name", str(source_meta.get("dataset") or "Canonical import DEM"),
            "--source-url", str(source_meta.get("serviceUrl") or ""),
            "--source-resolution-meters", str(source_meta.get("sourceResolutionMeters") or terrain_resolution),
        )
        run("tools/validate_course_green_detail.py", "--package", str(green_detail), "--course-package", str(final_package))
        run("tools/audit_course_green_surface_quality.py", "--package", str(green_detail), "--course-package", str(final_package))
    else:
        green_detail.unlink(missing_ok=True)

    # 5. Cache/provenance is part of the same successful import.
    cache_args = [
        "tools/update_course_cache_after_rebuild.py",
        "--cache", str(cache),
        "--config", str(config_path),
        "--snapshot", str(snapshot),
        "--package", str(final_package),
        "--manifest", str(manifest),
    ]
    if green_detail.exists():
        cache_args += ["--green-detail", str(green_detail)]
    run(*cache_args)

    # 6. Stamp one completion contract. Downstream CI can now distinguish a
    # complete import from a geometry-only intermediate artifact.
    validation = read_json(manifest)
    validation["canonicalImport"] = {
        "schemaVersion": "looper-canonical-import-completion-v1",
        "completedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "reason": args.reason,
        "complete": True,
        "freshOsm": True,
        "staticGeometry": True,
        "wholeHoleTerrain": terrain_enabled,
        "landcoverContext": landcover_enabled,
        "greenDetail": green_enabled,
        "terrainProvider": terrain_provider if terrain_enabled else None,
        "packageSha256": sha256(final_package),
        "greenDetailSha256": sha256(green_detail) if green_detail.exists() else None,
        "demSourceMetadata": str(dem_metadata.relative_to(ROOT)) if dem_metadata.exists() else None,
        "terrainComposeReport": str(compose_report.relative_to(ROOT)) if compose_report.exists() else None,
        "worldcoverAudit": str(landcover_audit.relative_to(ROOT)) if landcover_audit.exists() else None,
    }
    manifest.write_text(json.dumps(validation, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({
        "courseId": course_id,
        "courseSlug": slug,
        "complete": True,
        "package": str(final_package.relative_to(ROOT)),
        "terrain": terrain_enabled,
        "landcover": landcover_enabled,
        "greenDetail": green_enabled,
        "validation": str(manifest.relative_to(ROOT)),
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
