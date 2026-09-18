#!/usr/bin/env python3
"""Bounded, replaceable OSM snapshot provider for Looper course imports.

Cold loads race the configured public Overpass providers and accept the first
response that passes basic Looper snapshot validation. Slower requests are
abandoned from the caller's perspective so one unhealthy provider cannot add
its timeout to first-use course preparation latency.
"""

from __future__ import annotations

import json
import queue
import sys
import threading
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
RACE_GRACE_SECONDS = 2
USER_AGENT = "LooperCoursePackage/0.5 (+https://github.com/bpgpitt10/nova-v0)"


class SourceFetchError(RuntimeError):
    def __init__(self, message: str, attempts: list[dict[str, Any]]):
        super().__init__(message)
        self.attempts = attempts


def _elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000.0, 1)


def _fetch_one(
    endpoint: str,
    encoded: bytes,
    config: dict[str, Any],
    results: "queue.Queue[tuple[str, dict[str, Any], dict[str, Any] | None]]",
) -> None:
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
        results.put((endpoint, attempt, payload))
    except SystemExit as exc:
        attempt = {
            "endpoint": endpoint,
            "success": False,
            "durationMs": _elapsed_ms(started),
            "elementCount": None,
            "error": f"snapshot-validation: {exc}",
        }
        results.put((endpoint, attempt, None))
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError) as exc:
        attempt = {
            "endpoint": endpoint,
            "success": False,
            "durationMs": _elapsed_ms(started),
            "elementCount": None,
            "error": f"{type(exc).__name__}: {exc}",
        }
        results.put((endpoint, attempt, None))


def fetch_snapshot(config: dict[str, Any], snapshot_path: Path) -> dict[str, Any]:
    query = importer.build_overpass_query(config)
    encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")
    started = time.perf_counter()
    results: "queue.Queue[tuple[str, dict[str, Any], dict[str, Any] | None]]" = queue.Queue()
    attempts_by_endpoint: dict[str, dict[str, Any]] = {}

    # Daemon workers are intentional: once a valid snapshot wins the race, the
    # importer should continue immediately rather than waiting for slow sockets
    # to reach their individual timeout. Their eventual results are irrelevant.
    for endpoint in OVERPASS_ENDPOINTS:
        threading.Thread(
            target=_fetch_one,
            args=(endpoint, encoded, config, results),
            name=f"osm-source-{endpoint}",
            daemon=True,
        ).start()

    remaining = len(OVERPASS_ENDPOINTS)
    overall_timeout = PER_ENDPOINT_TIMEOUT_SECONDS + RACE_GRACE_SECONDS
    deadline = time.perf_counter() + overall_timeout
    winner_endpoint: str | None = None
    winner_payload: dict[str, Any] | None = None

    while remaining > 0 and time.perf_counter() < deadline:
        timeout = max(0.01, deadline - time.perf_counter())
        try:
            endpoint, attempt, payload = results.get(timeout=timeout)
        except queue.Empty:
            break
        attempts_by_endpoint[endpoint] = attempt
        remaining -= 1
        if payload is not None and attempt.get("success") is True:
            winner_endpoint = endpoint
            winner_payload = payload
            break
        print(
            f"OSM source attempt failed at {endpoint} after {attempt['durationMs']} ms: "
            f"{attempt.get('error')}",
            file=sys.stderr,
        )

    decision_ms = _elapsed_ms(started)
    attempts: list[dict[str, Any]] = []
    for endpoint in OVERPASS_ENDPOINTS:
        attempt = attempts_by_endpoint.get(endpoint)
        if attempt is None:
            attempt = {
                "endpoint": endpoint,
                "success": False,
                "durationMs": decision_ms,
                "elementCount": None,
                "error": "abandoned-after-winner" if winner_payload is not None else "race-deadline-exceeded",
            }
        attempts.append(attempt)

    if winner_payload is None or winner_endpoint is None:
        raise SourceFetchError("All configured OSM source endpoints failed", attempts)

    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = snapshot_path.with_suffix(snapshot_path.suffix + ".tmp")
    temporary.write_text(json.dumps(winner_payload), encoding="utf-8")
    temporary.replace(snapshot_path)
    print(
        f"OSM snapshot fetched from {winner_endpoint} in {decision_ms} ms (provider race)",
        file=sys.stderr,
    )
    return {
        "endpoint": winner_endpoint,
        "attempts": attempts,
        "sourceBaseTimestamp": importer.source_base_timestamp(winner_payload),
    }
