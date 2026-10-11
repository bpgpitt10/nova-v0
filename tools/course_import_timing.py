"""Durable per-command timing for canonical course imports.

Writes after every subprocess so failed runs retain timing evidence.
These are importer-machine timings; API discovery, CI queue, publish and visual
acceptance are separate operator/customer clocks.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


def stamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


PHASE_BY_TOOL = {
    "generate-imported-course-registry.mjs": "registry",
    "fetch_osm_course_snapshot_core.py": "osm-geometry",
    "diagnose_course_route_orientation.py": "osm-geometry",
    "build_osm_course_package_canonical.py": "osm-geometry",
    "fetch_course_dem.py": "terrain",
    "build_course_terrain.py": "terrain",
    "compose_course_package_canonical.py": "terrain",
    "enrich_worldcover_context.py": "landcover",
    "validate_course_landcover_masks.py": "landcover-validation",
    "build_course_green_detail.py": "green-detail",
    "validate_course_green_detail.py": "green-detail",
    "audit_course_green_surface_quality.py": "green-detail",
    "update_course_cache_after_rebuild.py": "cache-provenance",
    "validate-course-import-contract.mjs": "static-validation",
    "validate-course-runtime.mjs": "runtime-validation",
}


class ImportTiming:
    def __init__(self, root: Path, slug: str, config: str, reason: str):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", slug):
            raise ValueError("Unsafe course slug")
        self.started = time.monotonic()
        self.path = root / "artifacts" / "course-geometry" / slug / "import-timing-v1.json"
        self.old_cache = (self.path.parent / "cache-v1.json").exists()
        self.doc = {
            "schemaVersion": "looper-course-import-timing-v1",
            "courseSlug": slug,
            "configPath": str(config),
            "reason": reason,
            "startedAt": stamp(),
            "status": "running",
            "previousCachePresent": self.old_cache,
            "cacheHitVerified": None,
            "steps": [],
            "phaseDurationsSeconds": {},
            "failedSteps": 0,
        }
        audit_path = root / "artifacts" / "course-discovery-v1.json"
        if reason == "user-name-cold-import" and audit_path.exists():
            try:
                audit = json.loads(audit_path.read_text(encoding="utf-8"))
                if audit.get("status") == "resolved" and audit.get("courseSlug") == slug and audit.get("requestedAt"):
                    request_at = datetime.fromisoformat(audit["requestedAt"].replace("Z", "+00:00"))
                    if request_at.tzinfo is not None:
                        self.requested_at = request_at
                        self.doc["requestedAt"] = audit["requestedAt"]
                        self.doc["discoveryWallSeconds"] = audit.get("discoveryWallSeconds")
                        self.doc["requestToImporterSeconds"] = round(max(0.0, (datetime.now(timezone.utc) - request_at).total_seconds()), 3)
            except (OSError, ValueError, KeyError, TypeError):
                pass  # Timing must never block a valid import.
        self.flush()

    def flush(self):
        self.doc["updatedAt"] = stamp()
        self.doc["elapsedWallSeconds"] = round(time.monotonic() - self.started, 3)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def execute(self, command: list[str], cwd: Path):
        tool = Path(command[1]).name
        phase = PHASE_BY_TOOL.get(tool, "other")
        started = time.monotonic()
        item = {"tool": tool, "phase": phase, "startedAt": stamp(), "status": "running"}
        self.doc["steps"].append(item)
        self.flush()
        try:
            subprocess.run(command, cwd=cwd, check=True)
        except BaseException as exc:
            item["status"] = "failed"
            item["error"] = str(exc)
            self.doc["failedSteps"] += 1
            raise
        else:
            item["status"] = "passed"
        finally:
            seconds = round(time.monotonic() - started, 3)
            item["durationSeconds"] = seconds
            item["finishedAt"] = stamp()
            current = self.doc["phaseDurationsSeconds"].get(phase, 0)
            self.doc["phaseDurationsSeconds"][phase] = round(current + seconds, 3)
            self.flush()

    def finish(self, status: str, error: str | None = None):
        self.doc["status"] = status
        self.doc["finishedAt"] = stamp()
        if error:
            self.doc["error"] = error
        self.doc["runtimeReady"] = status == "runtime-ready"
        request_at = getattr(self, "requested_at", None)
        if request_at is not None:
            self.doc["requestToImporterCompletionSeconds"] = round(
                max(0.0, (datetime.now(timezone.utc) - request_at).total_seconds()), 3
            )
        self.flush()
