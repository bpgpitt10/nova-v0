#!/usr/bin/env python3
"""One-shot canonical Looper course importer.

A successful run produces, in one transaction:
- fresh exact-boundary OSM snapshot
- V7 static golf geometry and route diagnostics
- whole-hole terrain through the canonical provider-neutral DEM seam
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


def _run_reporting(command: list[str]) -> None:
    """Run a step and, if it fails, end with the step's own last lines (not a
    CalledProcessError traceback), so the course-load page shows the reason."""
    print("+", " ".join(command), flush=True)
    proc = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    sys.stdout.write(proc.stdout)
    sys.stdout.flush()
    if proc.returncode != 0:
        step = Path(command[1]).name if len(command) > 1 else command[0]
        lines = [line.strip() for line in proc.stdout.strip().splitlines() if line.strip()]
        reason = " | ".join(lines[-3:])[-500:] or f"exit status {proc.returncode}"
        raise SystemExit(f"{step} failed: {reason}")


def run(*args: str) -> None:
    _run_reporting([sys.executable, *args])


def run_node(*args: str) -> None:
    _run_reporting(["node", *args])


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


def likely_usgs_3dep_coverage(config: dict[str, Any]) -> bool:
    """Conservative geography gate for zero-config USGS 3DEP acquisition.

    This is only provider selection, never a geometry/course special case. The
    provider itself still validates coverage and the downstream terrain builder
    requires >=95% valid samples for every hole.
    """
    center = config.get("osmCenter") or []
    if len(center) < 2:
        return False
    try:
        lat, lon = float(center[0]), float(center[1])
    except (TypeError, ValueError):
        return False
    conus = 24.0 <= lat <= 50.5 and -125.5 <= lon <= -65.0
    alaska = 51.0 <= lat <= 72.0 and -171.0 <= lon <= -129.0
    hawaii = 18.0 <= lat <= 23.0 and -161.5 <= lon <= -154.0
    puerto_rico = 17.0 <= lat <= 19.5 and -68.5 <= lon <= -65.0
    return conus or alaska or hawaii or puerto_rico


def resolve_terrain_provider(config: dict[str, Any], config_path: Path) -> tuple[str, list[str]]:
    terrain = config.get("terrain") or {}
    requested = str(terrain.get("provider") or "auto").strip().lower()
    source_url = str(terrain.get("sourceUrl") or "").strip()
    source_file_raw = str(terrain.get("sourceFile") or "").strip()
    dataset_name = str(terrain.get("datasetName") or "").strip()
    source_resolution = terrain.get("sourceResolutionMeters")

    if requested == "auto":
        if source_url:
            requested = "geotiff-url"
        elif source_file_raw:
            requested = "geotiff-file"
        elif likely_usgs_3dep_coverage(config):
            requested = "usgs-3dep"
        else:
            raise SystemExit(
                "No automatic high-resolution terrain provider is configured for this course geography. "
                "Set terrain.sourceUrl or terrain.sourceFile plus terrain.sourceResolutionMeters in the course build config. "
                "The importer will not substitute low-resolution global terrain and call the course complete."
            )

    if requested not in {"usgs-3dep", "geotiff-url", "geotiff-file"}:
        raise SystemExit(f"Unsupported terrain provider {requested!r}")

    extra: list[str] = []
    if requested == "geotiff-url":
        if not source_url:
            raise SystemExit("terrain.provider=geotiff-url requires terrain.sourceUrl")
        if not isinstance(source_resolution, (int, float)) or float(source_resolution) <= 0:
            raise SystemExit("terrain.provider=geotiff-url requires positive terrain.sourceResolutionMeters")
        extra += ["--source-url", source_url, "--source-resolution-meters", str(float(source_resolution))]
    elif requested == "geotiff-file":
        if not source_file_raw:
            raise SystemExit("terrain.provider=geotiff-file requires terrain.sourceFile")
        if not isinstance(source_resolution, (int, float)) or float(source_resolution) <= 0:
            raise SystemExit("terrain.provider=geotiff-file requires positive terrain.sourceResolutionMeters")
        source_file = Path(source_file_raw)
        if not source_file.is_absolute():
            # Prefer paths relative to the config, then repo-root paths for
            # backwards-friendly build configs.
            config_relative = (config_path.parent / source_file).resolve()
            source_file = config_relative if config_relative.exists() else (ROOT / source_file).resolve()
        extra += ["--source-file", str(source_file), "--source-resolution-meters", str(float(source_resolution))]

    if dataset_name:
        extra += ["--dataset-name", dataset_name]
    return requested, extra


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
    terrain_resolution = float(terrain_cfg.get("resolutionMeters") or 1.0)
    terrain_spacing = float(terrain_cfg.get("runtimeSpacingYards") or 10.0)
    terrain_provider, terrain_provider_args = resolve_terrain_provider(config, config_path) if terrain_enabled else ("disabled", [])

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

    # 2. Whole-hole terrain through the provider-neutral DEM seam.
    if terrain_enabled:
        run(
            "tools/fetch_course_dem.py",
            "--course-package", str(geometry),
            "--output", str(dem),
            "--metadata", str(dem_metadata),
            "--provider", terrain_provider,
            "--resolution-meters", str(terrain_resolution),
            *terrain_provider_args,
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
            "--source-url", str(source_meta.get("serviceUrl") or source_meta.get("sourceUrl") or ""),
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
        "terrainProvider": terrain_provider if terrain_enabled else None,
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
        "terrainProvider": terrain_provider if terrain_enabled else None,
        "landcover": landcover_enabled,
        "greenDetail": green_enabled,
        "validation": str(manifest.relative_to(ROOT)),
        "runtimeReceipt": str(runtime_receipt.relative_to(ROOT)),
        "runtimeRegistry": "src/courseGeometry/generatedImportedCourseRegistry.ts",
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
