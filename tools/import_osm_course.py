#!/usr/bin/env python3
"""Generic offline importer for Looper OSM-backed static course packages.

Runtime never talks to OpenStreetMap. This tool:
1. builds a bounded Overpass query from course config,
2. refreshes or reuses the cached OSM snapshot,
3. fills any missing per-hole reference metadata from OSM routes,
4. runs the topology-safe generic package compiler,
5. validates the resulting package before it can be published.

It intentionally preserves the source query/snapshot/validation proof beside the
generated package so cached geometry remains attributable and reproducible.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from copy import deepcopy
from pathlib import Path
from typing import Any

import build_osm_course_package as base

OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
USER_AGENT = "LooperCoursePackage/0.2 (+https://github.com/bpgpitt10/nova-v0)"
DEFAULT_CONTEXT_RADIUS_METERS = 1600
DEFAULT_MIN_ELEMENTS = 50


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument(
        "--refresh-osm",
        action="store_true",
        help="Fetch a fresh OSM snapshot even when a cached snapshot exists.",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Require an existing cached OSM snapshot; never call Overpass.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
    )
    return parser.parse_args()


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("schemaVersion") != "looper-course-build-config-v1":
        raise SystemExit(f"{path}: unsupported course build config schema")
    for key in ("courseId", "courseName", "location", "osmCenter"):
        if not config.get(key):
            raise SystemExit(f"{path}: missing required {key}")
    center = config["osmCenter"]
    if (
        not isinstance(center, list)
        or len(center) != 2
        or not all(isinstance(value, (int, float)) for value in center)
    ):
        raise SystemExit(f"{path}: osmCenter must be [lat, lon]")
    return config


def slug_from_config(config: dict[str, Any], path: Path) -> str:
    slug = config.get("slug")
    if isinstance(slug, str) and slug.strip():
        return slug.strip()
    stem = re.sub(r"-v\d+$", "", path.stem)
    if stem:
        return stem
    raise SystemExit(f"{path}: could not derive course slug")


def osm_course_element(config: dict[str, Any]) -> tuple[str, int]:
    raw = config.get("osmCourseElement")
    if isinstance(raw, dict):
        element_type = raw.get("type")
        element_id = raw.get("id")
    else:
        element_type = "way"
        element_id = config.get("osmCourseWayId")

    if element_type not in {"way", "relation"}:
        raise SystemExit("osmCourseElement.type must be 'way' or 'relation'")
    if not isinstance(element_id, int) or element_id <= 0:
        raise SystemExit("course config requires a positive OSM course element id")
    return element_type, element_id


def build_overpass_query(config: dict[str, Any]) -> str:
    element_type, element_id = osm_course_element(config)
    lat, lon = config["osmCenter"]
    radius = int(config.get("osmContextRadiusMeters") or DEFAULT_CONTEXT_RADIUS_METERS)
    selector = "way" if element_type == "way" else "rel"
    return f"""[out:json][timeout:120];
{selector}({element_id});
map_to_area -> .courseArea;
(
  nwr(area.courseArea)["golf"];
  nwr(area.courseArea)["natural"="water"];
  nwr(area.courseArea)["landuse"="reservoir"];
  nwr(around:{radius},{lat},{lon})["natural"~"^(wood|scrub)$"];
  nwr(around:{radius},{lat},{lon})["landuse"~"^(forest|grass|meadow)$"];
);
out body geom;
"""


def fetch_overpass(query: str) -> dict[str, Any]:
    encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_error: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        request = urllib.request.Request(
            endpoint,
            data=encoded,
            headers={
                "User-Agent": USER_AGENT,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=150) as response:
                payload = json.load(response)
            if not isinstance(payload, dict):
                raise ValueError("Overpass returned a non-object payload")
            return payload
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            print(f"Overpass fetch failed at {endpoint}: {exc}", file=sys.stderr)
    raise SystemExit(f"All Overpass endpoints failed: {last_error}")


def validate_snapshot(payload: dict[str, Any], config: dict[str, Any]) -> None:
    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise SystemExit("OSM snapshot does not contain an elements array")
    minimum = int(config.get("minimumOsmElements") or DEFAULT_MIN_ELEMENTS)
    if len(elements) < minimum:
        raise SystemExit(
            f"OSM snapshot unexpectedly small: {len(elements)} elements; expected at least {minimum}"
        )


def route_length_yards(route: dict[str, Any]) -> float:
    points = route["geometry"]
    return sum(base.haversine_yards(a, b) for a, b in zip(points, points[1:]))


def effective_config(
    config: dict[str, Any],
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[int]]:
    """Fill missing hole metadata from OSM without overriding reviewed config."""
    resolved = deepcopy(config)

    # The current v2 compiler predates relation-backed course configs and still
    # expects this legacy field while writing its metadata. Supply it only as an
    # internal compatibility bridge; normalize the emitted provenance afterward.
    _element_type, element_id = osm_course_element(resolved)
    resolved.setdefault("osmCourseWayId", element_id)

    _features, hole_routes = base.normalize_osm(payload)
    missing_routes = sorted(set(range(1, 19)) - set(hole_routes))
    if missing_routes:
        raise SystemExit(f"Missing OSM golf=hole routes: {missing_routes}")

    holes = resolved.setdefault("holes", {})
    inferred: list[int] = []
    for hole_number in range(1, 19):
        key = str(hole_number)
        raw_hole = holes.setdefault(key, {})
        route = hole_routes[hole_number]

        if not raw_hole.get("par"):
            par = route.get("par")
            if isinstance(par, str) and par.isdigit():
                raw_hole["par"] = int(par)
            elif isinstance(par, (int, float)):
                raw_hole["par"] = int(par)

        if not isinstance(raw_hole.get("targetYards"), (int, float)):
            raw_hole["targetYards"] = round(route_length_yards(route), 1)
            inferred.append(hole_number)

    return resolved, inferred


def run_compiler(
    *,
    repo_root: Path,
    config: dict[str, Any],
    snapshot_path: Path,
    output_path: Path,
    manifest_path: Path,
) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        suffix=".json",
        delete=False,
    ) as handle:
        json.dump(config, handle, indent=2)
        effective_path = Path(handle.name)

    try:
        command = [
            sys.executable,
            str(repo_root / "tools" / "build_osm_course_package_v3.py"),
            "--osm",
            str(snapshot_path),
            "--config",
            str(effective_path),
            "--output",
            str(output_path),
            "--manifest",
            str(manifest_path),
        ]
        subprocess.run(command, cwd=repo_root, check=True)
    finally:
        effective_path.unlink(missing_ok=True)


def normalize_source_metadata(
    *,
    config: dict[str, Any],
    output_path: Path,
    manifest_path: Path,
) -> None:
    """Replace the compiler's legacy way-only metadata with generic OSM identity."""
    element_type, element_id = osm_course_element(config)
    source_element = {"type": element_type, "id": element_id}
    source_url = f"https://www.openstreetmap.org/{element_type}/{element_id}"

    package = json.loads(output_path.read_text(encoding="utf-8"))
    provenance = package.setdefault("provenance", {})
    provenance["sourceUrl"] = source_url
    provenance["sourceElement"] = source_element
    output_path.write_text(json.dumps(package, indent=2, sort_keys=True), encoding="utf-8")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["osmCourseElement"] = source_element
    if element_type == "relation":
        manifest.pop("osmCourseWayId", None)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")


def validate_manifest(manifest_path: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("osmHoleRoutes") != 18:
        raise SystemExit(f"Expected 18 OSM hole routes; got {manifest.get('osmHoleRoutes')}")
    if manifest.get("readyHoleCount") != 18:
        raise SystemExit(
            f"Expected 18 ready holes; got {manifest.get('readyHoleCount')}: "
            f"{manifest.get('readyHoles')}"
        )
    if manifest.get("allHolesStaticGeometryReady") is not True:
        raise SystemExit("Static geometry validation did not pass for all 18 holes")
    return manifest


def topology_diagnostics(payload: dict[str, Any]) -> dict[str, int]:
    relations = 0
    multipolygons = 0
    inner_members = 0
    for element in payload.get("elements", []):
        if element.get("type") != "relation":
            continue
        relations += 1
        if (element.get("tags") or {}).get("type") == "multipolygon":
            multipolygons += 1
        inner_members += sum(
            1 for member in (element.get("members") or []) if member.get("role") == "inner"
        )
    return {
        "relations": relations,
        "multipolygons": multipolygons,
        "innerMembers": inner_members,
    }


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    config_path = args.config.resolve()
    config = load_config(config_path)
    slug = slug_from_config(config, config_path)

    artifact_dir = repo_root / "artifacts" / "course-geometry" / slug
    public_dir = repo_root / "public" / "course-geometry" / slug
    artifact_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)

    snapshot_path = artifact_dir / "osm-snapshot.json"
    query_path = artifact_dir / "overpass-query.txt"
    manifest_path = artifact_dir / "validation-v1.json"
    output_path = public_dir / "course-v1.json"

    query = build_overpass_query(config)
    query_path.write_text(query, encoding="utf-8")

    if args.offline and args.refresh_osm:
        raise SystemExit("--offline and --refresh-osm cannot be used together")

    should_fetch = args.refresh_osm or not snapshot_path.exists()
    if should_fetch:
        if args.offline:
            raise SystemExit(f"No cached OSM snapshot at {snapshot_path}")
        payload = fetch_overpass(query)
        snapshot_path.write_text(json.dumps(payload), encoding="utf-8")
    else:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))

    validate_snapshot(payload, config)
    resolved_config, inferred_holes = effective_config(config, payload)
    run_compiler(
        repo_root=repo_root,
        config=resolved_config,
        snapshot_path=snapshot_path,
        output_path=output_path,
        manifest_path=manifest_path,
    )
    normalize_source_metadata(
        config=config,
        output_path=output_path,
        manifest_path=manifest_path,
    )
    manifest = validate_manifest(manifest_path)

    element_type, element_id = osm_course_element(config)
    summary = {
        "courseId": config["courseId"],
        "slug": slug,
        "osmCourseElement": {"type": element_type, "id": element_id},
        "snapshot": str(snapshot_path.relative_to(repo_root)),
        "package": str(output_path.relative_to(repo_root)),
        "manifest": str(manifest_path.relative_to(repo_root)),
        "inferredReferenceYardageHoles": inferred_holes,
        "topology": topology_diagnostics(payload),
        "readyHoleCount": manifest.get("readyHoleCount"),
        "registrationStatus": manifest.get("registrationStatus"),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
