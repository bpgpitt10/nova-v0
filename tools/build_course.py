#!/usr/bin/env python3
"""Build one Looper course candidate without publishing it.

This is the canonical orchestration entry point for course ingestion.  It turns
one ``looper-course-build-config-v1`` file into a staged candidate package:

    exact course identity
      -> OSM snapshot + coherent 1-18 hole-family resolution
      -> canonical V7 geometry compile
      -> optional current-frame terrain build
      -> geometry/terrain composition
      -> one machine-readable PASS / REVIEW / FAIL summary

Safety contract
---------------
This command NEVER writes to ``public/course-geometry``.  Candidates live under
``artifacts/course-build/<slug>/candidate`` (or an explicitly supplied staging
root).  Promotion is intentionally a separate, future/explicit approval step.

Examples
--------
Plan only (no network, no writes):

    python tools/build_course.py \
      --config config/course-geometry/augusta-national-v1.json \
      --plan

Build a full candidate including terrain when the configured provider is
supported:

    python tools/build_course.py \
      --config config/course-geometry/augusta-national-v1.json

Focused terrain validation while developing an importer/provider:

    python tools/build_course.py \
      --config config/course-geometry/example-v1.json \
      --terrain-holes 1,6
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = "looper-course-build-config-v1"
SUMMARY_SCHEMA = "looper-course-build-summary-v1"
SUPPORTED_TERRAIN_PROVIDERS = {"usgs-3dep-1m"}
ALL_HOLES = list(range(1, 19))

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = REPO_ROOT / "tools"
DEFAULT_OUTPUT_ROOT = REPO_ROOT / "artifacts" / "course-build"


class BuildError(RuntimeError):
    pass


@dataclass
class StepResult:
    name: str
    command: list[str]
    elapsed_seconds: float
    stdout: str
    stderr: str

    def summary(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "command": [display_path(value) for value in self.command],
            "elapsedSeconds": round(self.elapsed_seconds, 2),
            "stdoutTail": tail(self.stdout),
            "stderrTail": tail(self.stderr),
        }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def display_path(value: str) -> str:
    try:
        path = Path(value)
        if path.is_absolute():
            return str(path.relative_to(REPO_ROOT))
    except (TypeError, ValueError):
        pass
    return value


def tail(value: str, lines: int = 20) -> str:
    items = value.strip().splitlines()
    return "\n".join(items[-lines:])


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise BuildError(f"{path}: expected a JSON object")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_holes(raw: str) -> list[int]:
    holes: set[int] = set()
    for token in str(raw).split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            left, right = token.split("-", 1)
            try:
                start, end = int(left), int(right)
            except ValueError as exc:
                raise BuildError(f"Invalid terrain hole range {token!r}") from exc
            if end < start:
                start, end = end, start
            holes.update(range(start, end + 1))
        else:
            try:
                holes.add(int(token))
            except ValueError as exc:
                raise BuildError(f"Invalid terrain hole {token!r}") from exc
    if not holes or min(holes) < 1 or max(holes) > 18:
        raise BuildError("--terrain-holes must resolve to hole numbers 1..18")
    return sorted(holes)


def validate_config(config: dict[str, Any]) -> None:
    if config.get("schemaVersion") != SCHEMA:
        raise BuildError(f"Unsupported config schema: {config.get('schemaVersion')!r}")
    for key in ("courseId", "courseName", "location", "slug"):
        value = config.get(key)
        if not isinstance(value, str) or not value.strip():
            raise BuildError(f"config.{key} is required")

    source = config.get("osmCourseElement")
    if not isinstance(source, dict):
        raise BuildError("config.osmCourseElement is required")
    source_type = source.get("type")
    source_id = source.get("id")
    if source_type not in {"way", "relation"} or not isinstance(source_id, int):
        raise BuildError("config.osmCourseElement must contain type=way|relation and integer id")


def terrain_decision(config: dict[str, Any], mode: str) -> tuple[bool, str | None, str | None]:
    terrain = config.get("terrain") or {}
    provider = terrain.get("provider") if isinstance(terrain, dict) else None
    provider = str(provider) if provider else None

    if mode == "off":
        return False, provider, "terrain disabled by build option"
    if provider in SUPPORTED_TERRAIN_PROVIDERS:
        return True, provider, None
    if mode == "required":
        if provider is None:
            raise BuildError("Terrain is required but config.terrain.provider is not configured")
        raise BuildError(f"Terrain provider {provider!r} is not supported by build-course yet")
    if provider is None:
        return False, None, "terrain provider is not configured"
    return False, provider, f"terrain provider {provider!r} is not supported by build-course yet"


def candidate_dir_for(config: dict[str, Any], output_root: Path) -> Path:
    slug = str(config["slug"]).strip()
    if not slug or slug in {".", ".."} or "/" in slug or "\\" in slug:
        raise BuildError(f"Unsafe course slug: {slug!r}")
    return output_root.resolve() / slug / "candidate"


def ensure_safe_candidate_dir(candidate_dir: Path, output_root: Path) -> None:
    root = output_root.resolve()
    candidate = candidate_dir.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise BuildError(f"Candidate directory must remain under staging root {root}") from exc
    if candidate == root:
        raise BuildError("Refusing to use staging root itself as candidate directory")
    # The build pipeline must never publish directly into the runtime tree.
    public_root = (REPO_ROOT / "public" / "course-geometry").resolve()
    try:
        candidate.relative_to(public_root)
    except ValueError:
        pass
    else:
        raise BuildError("build-course candidates may not be written under public/course-geometry")


def run_step(name: str, command: list[str], *, cwd: Path = REPO_ROOT) -> StepResult:
    started = time.monotonic()
    completed = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    elapsed = time.monotonic() - started
    result = StepResult(name, command, elapsed, completed.stdout, completed.stderr)
    print(f"\n=== {name} ===")
    if completed.stdout.strip():
        print(completed.stdout.rstrip())
    if completed.stderr.strip():
        print(completed.stderr.rstrip(), file=sys.stderr)
    if completed.returncode != 0:
        raise BuildError(f"{name} failed with exit code {completed.returncode}")
    return result


def build_plan(
    config: dict[str, Any],
    *,
    candidate_dir: Path,
    terrain_mode: str,
    terrain_holes: list[int],
) -> dict[str, Any]:
    terrain_enabled, provider, terrain_note = terrain_decision(config, terrain_mode)
    return {
        "schemaVersion": "looper-course-build-plan-v1",
        "courseId": config["courseId"],
        "courseName": config["courseName"],
        "slug": config["slug"],
        "source": config["osmCourseElement"],
        "candidateDirectory": display_path(str(candidate_dir)),
        "publishesRuntimePackage": False,
        "terrain": {
            "mode": terrain_mode,
            "enabled": terrain_enabled,
            "provider": provider,
            "holes": terrain_holes if terrain_enabled else [],
            "note": terrain_note,
        },
        "stages": [
            "resolve-course-and-hole-family",
            "compile-canonical-v7-geometry",
            *(["build-current-frame-terrain", "compose-geometry-and-terrain"] if terrain_enabled else []),
            "validate-candidate",
        ],
    }


def frame_origin(hole: dict[str, Any]) -> str | None:
    frame = hole.get("coordinateFrame")
    return frame.get("origin") if isinstance(frame, dict) else None


def summarize_candidate(
    *,
    config: dict[str, Any],
    plan: dict[str, Any],
    snapshot_path: Path,
    geometry_path: Path,
    geometry_validation_path: Path,
    course_path: Path,
    terrain_validation_path: Path | None,
    steps: list[StepResult],
    build_started_at: str,
) -> dict[str, Any]:
    snapshot = read_json(snapshot_path)
    geometry = read_json(geometry_path)
    geometry_validation = read_json(geometry_validation_path)
    course = read_json(course_path)

    reasons: list[str] = []
    failures: list[str] = []

    holes = course.get("holes") or {}
    if sorted(int(key) for key in holes if str(key).isdigit()) != ALL_HOLES:
        failures.append("candidate package does not contain exactly holes 1-18")
    if course.get("courseId") != config.get("courseId"):
        failures.append("candidate courseId does not match config")

    ready_count = int(geometry_validation.get("readyHoleCount") or 0)
    all_geometry_ready = bool(geometry_validation.get("allHolesStaticGeometryReady"))
    if not all_geometry_ready or ready_count != 18:
        failures.append(f"static geometry ready for {ready_count}/18 holes")

    geometry_holes = geometry_validation.get("holes") or []
    warning_holes = [
        int(item.get("hole"))
        for item in geometry_holes
        if isinstance(item, dict) and item.get("warnings")
    ]
    if warning_holes:
        reasons.append(f"geometry warnings on holes {warning_holes}")

    origin_counts: dict[str, int] = {}
    virtual_tee_holes: list[int] = []
    for raw_hole, value in sorted(holes.items(), key=lambda item: int(item[0])):
        if not isinstance(value, dict):
            continue
        origin = frame_origin(value) or "unknown"
        origin_counts[origin] = origin_counts.get(origin, 0) + 1
        if origin != "selected-tee":
            virtual_tee_holes.append(int(raw_hole))
    if virtual_tee_holes:
        reasons.append(f"non-mapped/virtual tee anchors require review on holes {virtual_tee_holes}")

    looper_snapshot = snapshot.get("looperSnapshot") or {}
    family = looper_snapshot.get("holeRouteResolution") or {}
    duplicate_refs = family.get("duplicateRefs") or []

    terrain_plan = plan["terrain"]
    terrain_summary: dict[str, Any] = {
        "enabled": terrain_plan["enabled"],
        "provider": terrain_plan["provider"],
        "requestedHoles": terrain_plan["holes"],
        "readyHoles": [],
        "allRequestedReady": False,
    }
    if terrain_plan["enabled"]:
        if terrain_validation_path is None or not terrain_validation_path.exists():
            failures.append("terrain was enabled but no terrain validation artifact was produced")
        else:
            terrain_validation = read_json(terrain_validation_path)
            ready_holes = [
                int(item["hole"])
                for item in terrain_validation.get("holes") or []
                if isinstance(item, dict) and item.get("ready")
            ]
            all_requested_ready = bool(terrain_validation.get("allRequestedHolesTerrainReady"))
            terrain_summary.update({
                "readyHoles": ready_holes,
                "allRequestedReady": all_requested_ready,
                "sourceResolutionMeters": terrain_validation.get("sourceResolutionMeters"),
                "holes": terrain_validation.get("holes") or [],
            })
            if not all_requested_ready or ready_holes != terrain_plan["holes"]:
                failures.append(
                    f"terrain ready for {len(ready_holes)}/{len(terrain_plan['holes'])} requested holes"
                )
            if terrain_plan["holes"] != ALL_HOLES:
                reasons.append(
                    f"terrain build is intentionally partial ({len(terrain_plan['holes'])}/18 holes)"
                )
    else:
        reasons.append(terrain_plan.get("note") or "terrain was not built")

    status = "FAIL" if failures else ("REVIEW" if reasons else "PASS")
    return {
        "schemaVersion": SUMMARY_SCHEMA,
        "status": status,
        "courseId": config["courseId"],
        "courseName": config["courseName"],
        "slug": config["slug"],
        "buildStartedAt": build_started_at,
        "buildCompletedAt": utc_now(),
        "publishesRuntimePackage": False,
        "candidatePackage": display_path(str(course_path)),
        "failures": failures,
        "reviewReasons": reasons,
        "courseIdentity": {
            "osmCourseElement": config["osmCourseElement"],
            "holeRouteResolutionMethod": family.get("method"),
            "duplicateHoleRefs": duplicate_refs,
            "familyMarginYards": family.get("marginYards"),
            "maxHandoffYards": family.get("maxHandoffYards"),
        },
        "geometry": {
            "compiler": geometry.get("compiler") or geometry_validation.get("compiler"),
            "readyHoles": ready_count,
            "allHolesReady": all_geometry_ready,
            "warningHoles": warning_holes,
            "coordinateFrameOrigins": origin_counts,
            "virtualTeeHoles": virtual_tee_holes,
        },
        "terrain": terrain_summary,
        "steps": [result.summary() for result in steps],
        "artifacts": {
            "snapshot": display_path(str(snapshot_path)),
            "geometry": display_path(str(geometry_path)),
            "geometryValidation": display_path(str(geometry_validation_path)),
            "terrainValidation": (
                display_path(str(terrain_validation_path)) if terrain_validation_path else None
            ),
            "candidatePackage": display_path(str(course_path)),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help="Staging root only; runtime public/course-geometry is rejected.",
    )
    parser.add_argument(
        "--terrain-mode",
        choices=("auto", "required", "off"),
        default="auto",
        help="auto builds terrain when the config uses a supported provider.",
    )
    parser.add_argument(
        "--terrain-holes",
        default="1-18",
        help="Hole slice for terrain validation; full candidate default is 1-18.",
    )
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--plan", action="store_true", help="Print plan only; no network or writes.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config_path = args.config if args.config.is_absolute() else REPO_ROOT / args.config
    if not config_path.exists():
        raise BuildError(f"Config does not exist: {config_path}")
    config = read_json(config_path)
    validate_config(config)
    terrain_holes = parse_holes(args.terrain_holes)

    output_root = args.output_root if args.output_root.is_absolute() else REPO_ROOT / args.output_root
    candidate_dir = candidate_dir_for(config, output_root)
    ensure_safe_candidate_dir(candidate_dir, output_root)
    plan = build_plan(
        config,
        candidate_dir=candidate_dir,
        terrain_mode=args.terrain_mode,
        terrain_holes=terrain_holes,
    )
    if args.plan:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0

    if candidate_dir.exists():
        shutil.rmtree(candidate_dir)
    candidate_dir.mkdir(parents=True, exist_ok=True)
    write_json(candidate_dir / "build-plan.json", plan)

    snapshot = candidate_dir / "osm-snapshot.json"
    geometry = candidate_dir / "geometry-v1.json"
    geometry_validation = candidate_dir / "geometry-validation-v1.json"
    terrain_source = candidate_dir / "terrain-source-v1.json"
    terrain_package = candidate_dir / "terrain-v1.json"
    terrain_validation = candidate_dir / "terrain-validation-v1.json"
    terrain_cache = candidate_dir / "terrain-cache-v1.json"
    compose_report = candidate_dir / "terrain-compose-report-v1.json"
    course = candidate_dir / "course-v1.json"
    summary_path = candidate_dir / "build-summary.json"

    steps: list[StepResult] = []
    started_at = utc_now()
    active_step = "initialize"
    try:
        active_step = "resolve-course-and-hole-family"
        steps.append(run_step(active_step, [
            sys.executable,
            str(TOOLS_DIR / "fetch_osm_course_snapshot_family.py"),
            "--config", str(config_path),
            "--output", str(snapshot),
            "--timeout", str(args.timeout),
        ]))

        active_step = "compile-canonical-v7-geometry"
        steps.append(run_step(active_step, [
            sys.executable,
            str(TOOLS_DIR / "build_osm_course_package_canonical.py"),
            "--osm", str(snapshot),
            "--config", str(config_path),
            "--output", str(geometry),
            "--manifest", str(geometry_validation),
        ]))

        terrain_enabled = bool(plan["terrain"]["enabled"])
        if terrain_enabled:
            active_step = "build-current-frame-terrain"
            steps.append(run_step(active_step, [
                sys.executable,
                str(TOOLS_DIR / "import_course_terrain_v3.py"),
                "--config", str(config_path),
                "--geometry", str(geometry),
                "--source-out", str(terrain_source),
                "--terrain-out", str(terrain_package),
                "--validation-out", str(terrain_validation),
                "--cache-out", str(terrain_cache),
                "--holes", ",".join(str(value) for value in terrain_holes),
                "--force-refresh",
            ]))

            active_step = "compose-geometry-and-terrain"
            compose_command = [
                sys.executable,
                str(TOOLS_DIR / "compose_course_package.py"),
                "--geometry", str(geometry),
                "--terrain", str(terrain_package),
                "--output", str(course),
                "--report", str(compose_report),
            ]
            if terrain_holes != ALL_HOLES:
                compose_command.append("--allow-partial")
            steps.append(run_step(active_step, compose_command))
        else:
            shutil.copy2(geometry, course)

        active_step = "validate-candidate"
        summary = summarize_candidate(
            config=config,
            plan=plan,
            snapshot_path=snapshot,
            geometry_path=geometry,
            geometry_validation_path=geometry_validation,
            course_path=course,
            terrain_validation_path=terrain_validation if terrain_enabled else None,
            steps=steps,
            build_started_at=started_at,
        )
        write_json(summary_path, summary)
        print("\n=== build-course summary ===")
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 1 if summary["status"] == "FAIL" else 0

    except Exception as exc:  # noqa: BLE001 - preserve a failure artifact for CI/users
        failure = {
            "schemaVersion": SUMMARY_SCHEMA,
            "status": "FAIL",
            "courseId": config.get("courseId"),
            "courseName": config.get("courseName"),
            "slug": config.get("slug"),
            "buildStartedAt": started_at,
            "buildCompletedAt": utc_now(),
            "publishesRuntimePackage": False,
            "failedStage": active_step,
            "failures": [str(exc)],
            "reviewReasons": [],
            "steps": [result.summary() for result in steps],
        }
        write_json(summary_path, failure)
        print("\n=== build-course FAILED ===", file=sys.stderr)
        print(json.dumps(failure, indent=2, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BuildError as exc:
        print(f"build-course: {exc}", file=sys.stderr)
        raise SystemExit(2)
