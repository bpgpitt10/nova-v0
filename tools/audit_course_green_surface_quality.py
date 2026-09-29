#!/usr/bin/env python3
"""Audit high-resolution green terrain quality without rejecting legitimate steepness.

This runs after the structural green-detail validator. It checks that the encoded
terrain actually covers each canonical green polygon and reports how well small
3-yard neighborhoods behave as local planes. The local-plane diagnostics mirror
Live Caddie's tactical slope trust rule:

- at least 8 on-green samples within 3 yards
- RMS plane-fit error <= 0.35 ft is considered a trusted tactical patch
- there is deliberately NO maximum-slope rejection rule

A low trusted-fit ratio is a warning, not a hard failure: real tiers and ledges can
be nonlinear. Missing/poor DEM coverage and green/package registration mismatches
are hard failures because they indicate a broken ingest, not interesting terrain.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import statistics
import struct
import zlib
from pathlib import Path
from typing import Any

RADIUS_YDS = 3.0
MIN_LOCAL_SAMPLES = 8
TRUSTED_RMS_FT = 0.35
NODATA_DEFAULT = 65535


def polygon_area(points: list[list[float]]) -> float:
    if len(points) < 3:
        return 0.0
    total = 0.0
    for a, b in zip(points, points[1:] + points[:1]):
        total += float(a[0]) * float(b[1]) - float(b[0]) * float(a[1])
    return abs(total) / 2.0


def target_green_polygon(hole: dict[str, Any]) -> list[list[float]]:
    polygons = ((hole.get('surfaces') or {}).get('green') or [])
    candidates: list[list[list[float]]] = []
    for polygon in polygons:
        points: list[list[float]] = []
        for point in polygon or []:
            if (
                isinstance(point, (list, tuple))
                and len(point) >= 2
                and isinstance(point[0], (int, float))
                and isinstance(point[1], (int, float))
            ):
                points.append([float(point[0]), float(point[1])])
        if len(points) >= 3:
            candidates.append(points)
    if not candidates:
        raise ValueError('hole has no usable target-green polygon')
    return max(candidates, key=polygon_area)


def point_in_polygon(point: tuple[float, float], polygon: list[list[float]]) -> bool:
    x, y = point
    inside = False
    xj, yj = polygon[-1]
    for xi, yi in polygon:
        crosses = (yi > y) != (yj > y)
        if crosses:
            x_at_y = (xj - xi) * (y - yi) / ((yj - yi) + 1e-12) + xi
            if x < x_at_y:
                inside = not inside
        xj, yj = xi, yi
    return inside


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def solve_local_plane(samples: list[tuple[float, float, float]]) -> dict[str, float] | None:
    if len(samples) < MIN_LOCAL_SAMPLES:
        return None
    mx = statistics.fmean(x for x, _y, _z in samples)
    my = statistics.fmean(y for _x, y, _z in samples)
    mz = statistics.fmean(z for _x, _y, z in samples)
    sxx = syy = sxy = sxz = syz = 0.0
    for x, y, z in samples:
        dx, dy, dz = x - mx, y - my, z - mz
        sxx += dx * dx
        syy += dy * dy
        sxy += dx * dy
        sxz += dx * dz
        syz += dy * dz
    determinant = sxx * syy - sxy * sxy
    if abs(determinant) < 1e-9:
        return None
    rise_right = (sxz * syy - syz * sxy) / determinant
    rise_forward = (syz * sxx - sxz * sxy) / determinant
    residuals = [
        z - (mz + rise_right * (x - mx) + rise_forward * (y - my))
        for x, y, z in samples
    ]
    rms = math.sqrt(statistics.fmean(value * value for value in residuals))
    return {
        'rms': rms,
        'slopePercent': math.hypot(rise_right, rise_forward) / 3.0 * 100.0,
    }


def decode_grid(raw: dict[str, Any], nodata: int):
    grid = raw['grid']
    width = int(grid['width'])
    height = int(grid['height'])
    spacing = float(grid['spacingYds'])
    min_x = float(grid['minX'])
    min_y = float(grid['minY'])
    offset_ft = float(grid['elevationOffsetFt'])
    payload = zlib.decompress(base64.b64decode(grid['valuesBase64']))
    expected_bytes = width * height * 2
    if len(payload) != expected_bytes:
        raise ValueError(f'decoded grid is {len(payload)} bytes; expected {expected_bytes}')
    values = struct.unpack(f'<{width * height}H', payload)
    return width, height, spacing, min_x, min_y, offset_ft, values, nodata


def audit_hole(
    hole_number: int,
    course_hole: dict[str, Any],
    green_hole: dict[str, Any],
    nodata: int,
) -> tuple[dict[str, Any], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    polygon = target_green_polygon(course_hole)
    width, height, spacing, min_x, min_y, offset_ft, values, nodata = decode_grid(green_hole, nodata)

    candidate_on_green = 0
    nodes: dict[tuple[int, int], tuple[float, float, float]] = {}
    for row in range(height):
        y = min_y + row * spacing
        for column in range(width):
            x = min_x + column * spacing
            if not point_in_polygon((x, y), polygon):
                continue
            candidate_on_green += 1
            encoded = values[row * width + column]
            if encoded == nodata:
                continue
            nodes[(row, column)] = (x, y, offset_ft + encoded / 10.0)

    valid_on_green = len(nodes)
    coverage = valid_on_green / candidate_on_green if candidate_on_green else 0.0
    recorded_samples = green_hole.get('greenSampleCount')
    if candidate_on_green == 0:
        errors.append(f'H{hole_number}: green polygon contains no terrain grid nodes')
    if coverage < 0.90:
        errors.append(f'H{hole_number}: only {coverage:.1%} of green grid nodes have DEM coverage')
    elif coverage < 0.98:
        warnings.append(f'H{hole_number}: green DEM coverage is {coverage:.1%}')
    if isinstance(recorded_samples, int) and recorded_samples != valid_on_green:
        errors.append(
            f'H{hole_number}: greenSampleCount={recorded_samples} but canonical polygon/grid resolves {valid_on_green}'
        )

    radius_cells = max(1, math.ceil(RADIUS_YDS / spacing))
    fits: list[dict[str, float]] = []
    for (row, column), (x, y, _z) in nodes.items():
        samples: list[tuple[float, float, float]] = []
        for rr in range(row - radius_cells, row + radius_cells + 1):
            for cc in range(column - radius_cells, column + radius_cells + 1):
                sample = nodes.get((rr, cc))
                if sample is None:
                    continue
                if math.hypot(sample[0] - x, sample[1] - y) <= RADIUS_YDS + 1e-9:
                    samples.append(sample)
        fit = solve_local_plane(samples)
        if fit:
            fits.append(fit)

    trusted = [fit for fit in fits if fit['rms'] <= TRUSTED_RMS_FT]
    trusted_ratio = len(trusted) / len(fits) if fits else 0.0
    rms_values = [fit['rms'] for fit in fits]
    if not fits:
        errors.append(f'H{hole_number}: no 3-yard local plane can be fit on the green')
    elif trusted_ratio < 0.50:
        warnings.append(
            f'H{hole_number}: only {trusted_ratio:.1%} of local planes meet <= {TRUSTED_RMS_FT:.2f} ft RMS; '
            'review tiers/ledges or source quality'
        )

    metrics = {
        'hole': hole_number,
        'candidateOnGreenNodes': candidate_on_green,
        'validOnGreenNodes': valid_on_green,
        'greenCoverage': round(coverage, 4),
        'localFitCount': len(fits),
        'trustedLocalFitCount': len(trusted),
        'trustedLocalFitRatio': round(trusted_ratio, 4),
        'localRmsP50Ft': round(percentile(rms_values, 0.50), 3) if rms_values else None,
        'localRmsP95Ft': round(percentile(rms_values, 0.95), 3) if rms_values else None,
        'maxTrustedSlopePercent': round(max((fit['slopePercent'] for fit in trusted), default=0.0), 1),
    }
    return metrics, warnings, errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', type=Path, required=True, help='green-detail-v1.json')
    parser.add_argument('--course-package', type=Path, required=True, help='canonical course-v1.json')
    parser.add_argument('--strict-warnings', action='store_true')
    args = parser.parse_args()

    green = json.loads(args.package.read_text(encoding='utf-8-sig'))
    course = json.loads(args.course_package.read_text(encoding='utf-8-sig'))
    nodata = int((green.get('runtimeTerrain') or {}).get('nodata', NODATA_DEFAULT))
    green_holes = green.get('holes') or {}
    course_holes = course.get('holes') or {}

    metrics: list[dict[str, Any]] = []
    warnings: list[str] = []
    errors: list[str] = []
    for hole_number in range(1, 19):
        try:
            hole_metrics, hole_warnings, hole_errors = audit_hole(
                hole_number,
                course_holes[str(hole_number)],
                green_holes[str(hole_number)],
                nodata,
            )
            metrics.append(hole_metrics)
            warnings.extend(hole_warnings)
            errors.extend(hole_errors)
        except Exception as exc:
            errors.append(f'H{hole_number}: quality audit failed: {exc}')

    print(json.dumps({
        'contract': {
            'localRadiusYds': RADIUS_YDS,
            'minimumSamples': MIN_LOCAL_SAMPLES,
            'trustedRmsFt': TRUSTED_RMS_FT,
            'maximumSlopePercent': None,
            'note': 'Slope magnitude is diagnostic only; coherent steep banks are valid.',
        },
        'holes': metrics,
        'warnings': warnings,
        'errors': errors,
    }, indent=2))
    if errors:
        return 1
    if args.strict_warnings and warnings:
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
