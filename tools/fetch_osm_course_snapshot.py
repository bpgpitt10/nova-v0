#!/usr/bin/env python3
"""Bounded, replaceable OSM snapshot provider for Looper course imports."""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import import_osm_course as importer

# Current global public instances listed by the OpenStreetMap Overpass wiki.
# Keep this layer separate from package compilation so production can later
# swap in a hosted/paid provider without changing the CoursePackage builder.
OVERPASS_ENDPOINTS = (
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)
PER_ENDPOINT_TIMEOUT_SECONDS = 35
USER_AGENT = "LooperCoursePackage/0.4 (+https://github.com/bpgpitt10/nova-v0)"


class SourceFetchError(RuntimeError):
    def __init__(self, message: str, attempts: list[dict[str, Any]]):
        super().__init__(message)
        self.attempts = attempts


def _elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000.0, 1)


def fetch_snapshot(config: dict[str, Any], snapshot_path: Path) -> dict[str, Any]:
    query = importer.build_overpass_query(config)
    encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")
    attempts: list[dict[str, Any]] = []

    for endpoint in OVERPASS_ENDPOINTS:
        started = time.perf_counter()
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
            with urllib.request.urlopen(request, timeout=PER_ENDPOINT_TIMEOUT_SECONDS) as response:
                payload = json.load(response)
            if not isinstance(payload, dict):
                raise ValueError("Overpass returned a non-object payload")
            importer.validate_snapshot(payload, config)
            attempt = {
                "endpoint": endpoint,
                "success": True,
                "durationMs": _elapsed_ms(started),
                "elementCount": len(payload.get("elements") or []),
                "error": None,
            }
            attempts.append(attempt)
            snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = snapshot_path.with_suffix(snapshot_path.suffix + ".tmp")
            temporary.write_text(json.dumps(payload), encoding="utf-8")
            temporary.replace(snapshot_path)
            print(f"OSM snapshot fetched from {endpoint} in {attempt['durationMs']} ms", file=sys.stderr)
            return {
                "endpoint": endpoint,
                "attempts": attempts,
                "sourceBaseTimestamp": importer.source_base_timestamp(payload),
            }
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError) as exc:
            attempt = {
                "endpoint": endpoint,
                "success": False,
                "durationMs": _elapsed_ms(started),
                "elementCount": None,
                "error": f"{type(exc).__name__}: {exc}",
            }
            attempts.append(attempt)
            print(
                f"OSM source attempt failed at {endpoint} after {attempt['durationMs']} ms: {exc}",
                file=sys.stderr,
            )

    raise SourceFetchError("All configured OSM source endpoints failed", attempts)
