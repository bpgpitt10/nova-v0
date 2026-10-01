#!/usr/bin/env python3
"""One-shot canonical Looper course importer.

A successful run produces, in one transaction:
- fresh exact-boundary OSM snapshot
- V7 static golf geometry and route diagnostics
- automatic whole-hole bare-earth terrain
- automatic ESA WorldCover context fill
- high-resolution green-detail sampled from the same DEM
- cache/provenance refresh
- runtime contract validation (including usable tee candidates)
- automatic runtime catalog registration
- generic package + tee-provider smoke validation through the real Looper loaders
- a completion record only after every gate passes

The importer is intentionally fail-closed. "Complete" means the course can be
consumed by the existing Round Setup -> Live Caddie path without course-specific
runtime code or a manual catalog edit.
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


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run(*args: str) -> None:
    command = [sys.executable, *args]
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def run_node(*args: str) -> None:
    command = ["node", *args]
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
    if config.get("slug") != slug:
        raise SystemExit(f"Importer --slug {slug!r} does not match config slug {config.get('slug')!r}")
    aliases = [str(value).strip() for value in (config.get("gsproAliases") or []) if str(value).strip()]
    if not aliases:
        raise SystemExit("Course config must declare gsproAliases; runtime course identity may not require a hand edit after import")

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
    runtime_receipt = artifact_dir / "runtime-ready-v1.json"
    geometry = work_dir / "geometry.json"
    dem = work_dir / "course-dem.tif"
    dem_metadata = artifact_dir / "dem-source-v1.json"
    terrain_package = work_dir / "terrain.json"
    compose_report = artifact_dir / "terrain-compose-v1.json"
    final_package = public_dir / "course-v1.json"
    landcover_audit = artifact_dir / "worldcover-context-audit-v1.json"
    green_detail = public_dir / "green-detail-v1.json"
    cache = artifact_dir / "cache-v1.json"

    # A re-import begins by withdrawing the previous generated runtime
    # registration. There is never a window where stale output counts as a new
    # successful import.
    runtime_receipt.unlink(missing_ok=True)
    run_node("tools/generate-imported-course-registry.mjs")

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
        "--build-reason", args.reason,
    ]
    if green_detail.exists():
        cache_args += ["--green-detail", str(green_detail)]
    run(*cache_args)

    # 6. Static PRODUCT contract. Geometry is not enough: every imported course
    # must have the exact package/tee identity needed by Round Setup and the
    # generic runtime providers.
    run_node(
        "tools/validate-course-import-contract.mjs",
        "--package", str(final_package),
        "--config", str(config_path),
    )

    package_sha = sha256(final_package)
    provisional_receipt = {
        "schemaVersion": "looper-course-runtime-ready-v1",
        "courseId": course_id,
        "courseName": config.get("courseName"),
        "location": config.get("location"),
        "slug": slug,
        "gsproAliases": aliases,
        "staticReady": True,
        "runtimeReady": False,
        "terrainReady": terrain_enabled,
        "greenDetailReady": green_enabled,
        "packageSha256": package_sha,
        "configPath": str(config_path.relative_to(ROOT)),
        "packagePath": str(final_package.relative_to(ROOT)),
        "validationPath": str(manifest.relative_to(ROOT)),
        "reason": args.reason,
    }
    write_json(runtime_receipt, provisional_receipt)

    # 7. Register provisionally so the real generic providers can resolve the
    # course, then exercise all 18 holes and the same Hole 1 tee-provider path
    # used by Round Setup. Roll registration back on any failure.
    try:
        run_node("tools/generate-imported-course-registry.mjs", "--include-pending")
        run_node("tools/validate-course-runtime.mjs", "--course", course_id)
    except Exception:
        runtime_receipt.unlink(missing_ok=True)
        run_node("tools/generate-imported-course-registry.mjs")
        raise

    completed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    final_receipt = {
        **provisional_receipt,
        "runtimeReady": True,
        "completedAt": completed_at,
    }
    write_json(runtime_receipt, final_receipt)
    run_node("tools/generate-imported-course-registry.mjs")

    # 8. Only now may the import be stamped complete.
    validation = read_json(manifest)
    validation["canonicalImport"] = {
        "schemaVersion": "looper-canonical-import-completion-v2",
        "completedAt": completed_at,
        "reason": args.reason,
        "complete": True,
        "runtimeReady": True,
        "runtimeContract": "round-setup-to-live-caddie-v1",
        "freshOsm": True,
        "staticGeometry": True,
        "wholeHoleTerrain": terrain_enabled,
        "landcoverContext": landcover_enabled,
        "greenDetail": green_enabled,
        "terrainProvider": terrain_provider if terrain_enabled else None,
        "packageSha256": package_sha,
        "greenDetailSha256": sha256(green_detail) if green_detail.exists() else None,
        "runtimeReceipt": str(runtime_receipt.relative_to(ROOT)),
        "demSourceMetadata": str(dem_metadata.relative_to(ROOT)) if dem_metadata.exists() else None,
        "terrainComposeReport": str(compose_report.relative_to(ROOT)) if compose_report.exists() else None,
        "worldcoverAudit": str(landcover_audit.relative_to(ROOT)) if landcover_audit.exists() else None,
    }
    write_json(manifest, validation)

    print(json.dumps({
        "courseId": course_id,
        "courseSlug": slug,
        "complete": True,
        "runtimeReady": True,
        "package": str(final_package.relative_to(ROOT)),
        "terrain": terrain_enabled,
        "landcover": landcover_enabled,
        "greenDetail": green_enabled,
        "validation": str(manifest.relative_to(ROOT)),
        "runtimeReceipt": str(runtime_receipt.relative_to(ROOT)),
        "runtimeRegistry": "src/courseGeometry/generatedImportedCourseRegistry.ts",
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
