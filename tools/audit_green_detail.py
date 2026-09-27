#!/usr/bin/env python3
"""Audit high-resolution green terrain and the conservative green targeting rules.

This is deliberately a geometry/terrain QA tool, not a GSPro truth test. It checks
that every green has usable 1 yd terrain, that the terrain is internally smooth
enough to be plausible, and that the targeting/rollout transforms preserve their
hard invariants. Warnings identify holes worth visual/live validation; only broken
contracts fail the audit.
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

NODATA_DEFAULT = 65535
ROWS = ("front", "middle", "back")
COLUMNS = ("left", "center", "right")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def normalize(x: float, y: float) -> tuple[float, float] | None:
    length = math.hypot(x, y)
    return None if length <= 1e-9 else (x / length, y / length)


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = clamp(q, 0.0, 1.0) * (len(ordered) - 1)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def point_in_polygon(point: tuple[float, float], polygon: list[tuple[float, float]]) -> bool:
    x, y = point
    inside = False
    xj, yj = polygon[-1]
    for xi, yi in polygon:
        if (yi > y) != (yj > y):
            crossing_x = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < crossing_x:
                inside = not inside
        xj, yj = xi, yi
    return inside


def closest_point_on_segment(
    point: tuple[float, float],
    start: tuple[float, float],
    end: tuple[float, float],
) -> tuple[float, float]:
    dx, dy = end[0] - start[0], end[1] - start[1]
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-12:
        return start
    t = clamp(((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_sq, 0, 1)
    return (start[0] + dx * t, start[1] + dy * t)


def nearest_boundary(point: tuple[float, float], polygon: list[tuple[float, float]]):
    best = None
    best_distance = math.inf
    for index, start in enumerate(polygon):
        end = polygon[(index + 1) % len(polygon)]
        candidate = closest_point_on_segment(point, start, end)
        distance = math.hypot(candidate[0] - point[0], candidate[1] - point[1])
        if distance < best_distance:
            best_distance = distance
            best = candidate
    if best is None:
        return None
    inward = normalize(point[0] - best[0], point[1] - best[1])
    if inward is None:
        cx = sum(p[0] for p in polygon) / len(polygon)
        cy = sum(p[1] for p in polygon) / len(polygon)
        inward = normalize(cx - point[0], cy - point[1])
    return best_distance, inward


def target_green_polygon(path: Path) -> list[tuple[float, float]]:
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    greens = ((raw.get("features") or {}).get("green") or [])
    if not greens:
        raise ValueError(f"{path}: no target green")
    polygon = []
    for point in greens[0].get("polygon") or []:
        if not isinstance(point, dict):
            continue
        x, y = point.get("right_yards"), point.get("forward_yards")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            polygon.append((float(x), float(y)))
    if len(polygon) < 3:
        raise ValueError(f"{path}: target green has fewer than three vertices")
    return polygon


class Grid:
    def __init__(self, raw_hole: dict[str, Any], nodata: int):
        raw = raw_hole["grid"]
        self.min_x = float(raw["minX"])
        self.min_y = float(raw["minY"])
        self.spacing = float(raw["spacingYds"])
        self.width = int(raw["width"])
        self.height = int(raw["height"])
        self.offset = float(raw["elevationOffsetFt"])
        self.nodata = int(nodata)
        compressed = base64.b64decode(raw["valuesBase64"])
        payload = zlib.decompress(compressed)
        expected = self.width * self.height
        if len(payload) != expected * 2:
            raise ValueError(f"decoded {len(payload)} bytes; expected {expected * 2}")
        self.values = struct.unpack(f"<{expected}H", payload)

    def node(self, row: int, col: int) -> float | None:
        if row < 0 or col < 0 or row >= self.height or col >= self.width:
            return None
        value = self.values[row * self.width + col]
        if value == self.nodata:
            return None
        return self.offset + value / 10.0

    def point(self, row: int, col: int) -> tuple[float, float]:
        return (self.min_x + col * self.spacing, self.min_y + row * self.spacing)

    def sample(self, point: tuple[float, float]) -> float | None:
        x = (point[0] - self.min_x) / self.spacing
        y = (point[1] - self.min_y) / self.spacing
        if self.width < 2 or self.height < 2 or x < 0 or y < 0 or x > self.width - 1 or y > self.height - 1:
            return None
        c0 = min(math.floor(x), self.width - 2)
        r0 = min(math.floor(y), self.height - 2)
        dx, dy = x - c0, y - r0
        z00, z10 = self.node(r0, c0), self.node(r0, c0 + 1)
        z01, z11 = self.node(r0 + 1, c0), self.node(r0 + 1, c0 + 1)
        if None in (z00, z10, z01, z11):
            return None
        top = z00 * (1 - dx) + z10 * dx
        bottom = z01 * (1 - dx) + z11 * dx
        return top * (1 - dy) + bottom * dy


def smoothed_slope(grid: Grid, point: tuple[float, float]):
    radius = 3.0
    left = grid.sample((point[0] - radius, point[1]))
    right = grid.sample((point[0] + radius, point[1]))
    front = grid.sample((point[0], point[1] - radius))
    back = grid.sample((point[0], point[1] + radius))
    if None in (left, right, front, back):
        return None
    gx = (right - left) / (radius * 2)
    gy = (back - front) / (radius * 2)
    downhill = normalize(-gx, -gy)
    if downhill is None:
        return (0.0, (0.0, 0.0))
    return (math.hypot(gx, gy) / 3.0 * 100.0, downhill)


def safe_shifted_target(
    polygon: list[tuple[float, float]],
    grid: Grid,
    pin: tuple[float, float],
    shift: tuple[float, float],
):
    for scale in (1.0, 0.75, 0.5, 0.25):
        candidate = (pin[0] + shift[0] * scale, pin[1] + shift[1] * scale)
        if point_in_polygon(candidate, polygon) and grid.sample(candidate) is not None:
            return candidate
    return pin


def targeting_shift(grid: Grid, polygon: list[tuple[float, float]], pin: tuple[float, float]):
    slope = smoothed_slope(grid, pin)
    edge = nearest_boundary(pin, polygon)
    slope_pct = slope[0] if slope else 0.0
    downhill = slope[1] if slope else None
    slope_shift = clamp((slope_pct - 1.5) * 0.45, 0, 3) if downhill else 0.0
    uphill = (-downhill[0], -downhill[1]) if downhill else (0.0, 0.0)
    edge_shift = 0.0
    inward = (0.0, 0.0)
    if edge and edge[1]:
        edge_shift = clamp((7.0 - edge[0]) * 0.55, 0, 3.5)
        inward = edge[1]
    shift = (
        uphill[0] * slope_shift + inward[0] * edge_shift,
        uphill[1] * slope_shift + inward[1] * edge_shift,
    )
    raw = math.hypot(*shift)
    if raw > 5:
        shift = (shift[0] * 5 / raw, shift[1] * 5 / raw)
    if math.hypot(*shift) < 0.35:
        return pin, 0.0
    target = safe_shifted_target(polygon, grid, pin, shift)
    return target, math.hypot(target[0] - pin[0], target[1] - pin[1])


def redirect_rollout(grid: Grid, carry: tuple[float, float], baseline: tuple[float, float]):
    vector = (baseline[0] - carry[0], baseline[1] - carry[1])
    rollout = math.hypot(*vector)
    if rollout < 0.25:
        return baseline, False, 0.0
    slope = smoothed_slope(grid, carry)
    if not slope or slope[0] <= 1.25:
        return baseline, False, 0.0
    original = normalize(*vector)
    blend = clamp((slope[0] - 1.25) / 4.5, 0, 0.65)
    mixed = normalize(
        original[0] * (1 - blend) + slope[1][0] * blend,
        original[1] * (1 - blend) + slope[1][1] * blend,
    )
    if mixed is None or blend < 0.01:
        return baseline, False, blend
    return (carry[0] + mixed[0] * rollout, carry[1] + mixed[1] * rollout), True, blend


def representative_points(grid: Grid, polygon: list[tuple[float, float]], sectors: list[dict[str, Any]]):
    inside_nodes = []
    for row in range(grid.height):
        for col in range(grid.width):
            point = grid.point(row, col)
            if point_in_polygon(point, polygon) and grid.node(row, col) is not None:
                inside_nodes.append(point)
    output = []
    for sector in sectors:
        bounds = sector.get("boundsYds")
        if not isinstance(bounds, list) or len(bounds) != 4:
            continue
        center = ((bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2)
        candidates = [p for p in inside_nodes if bounds[0] <= p[0] <= bounds[1] and bounds[2] <= p[1] <= bounds[3]]
        if not candidates:
            continue
        point = min(candidates, key=lambda p: math.hypot(p[0] - center[0], p[1] - center[1]))
        output.append((str(sector.get("id") or "sector"), point))
    return output


def audit_hole(hole_number: int, raw: dict[str, Any], polygon: list[tuple[float, float]], nodata: int):
    grid = Grid(raw, nodata)
    warnings: list[str] = []
    errors: list[str] = []
    inside_total = 0
    inside_valid = 0
    jumps: list[float] = []
    slopes: list[float] = []

    for row in range(grid.height):
        for col in range(grid.width):
            point = grid.point(row, col)
            if not point_in_polygon(point, polygon):
                continue
            inside_total += 1
            elevation = grid.node(row, col)
            if elevation is None:
                continue
            inside_valid += 1
            slope = smoothed_slope(grid, point)
            if slope:
                slopes.append(slope[0])
            for dr, dc in ((0, 1), (1, 0)):
                neighbor = grid.node(row + dr, col + dc)
                neighbor_point = grid.point(row + dr, col + dc)
                if neighbor is not None and point_in_polygon(neighbor_point, polygon):
                    jumps.append(abs(neighbor - elevation))

    coverage = inside_valid / inside_total if inside_total else 0.0
    if coverage < 0.98:
        errors.append(f"green DEM node coverage {coverage:.1%} < 98%")
    sectors = raw.get("sectors") if isinstance(raw.get("sectors"), list) else []
    populated_sectors = sum(1 for sector in sectors if int(sector.get("sampleCount") or 0) > 0)
    if len(sectors) != 9:
        errors.append(f"expected 9 tactical sectors, got {len(sectors)}")
    if populated_sectors < 7:
        warnings.append(f"only {populated_sectors}/9 tactical sectors contain green samples")

    max_jump = max(jumps) if jumps else 0.0
    p95_jump = percentile(jumps, 0.95) or 0.0
    p95_slope = percentile(slopes, 0.95) or 0.0
    max_slope = max(slopes) if slopes else 0.0
    if p95_jump > 0.75:
        warnings.append(f"95th-percentile 1 yd elevation jump is {p95_jump:.2f} ft")
    if max_jump > 1.5:
        warnings.append(f"max 1 yd elevation jump is {max_jump:.2f} ft")
    if p95_slope > 8.0:
        warnings.append(f"95th-percentile smoothed slope is {p95_slope:.1f}%")
    if max_slope > 15.0:
        warnings.append(f"max smoothed slope is {max_slope:.1f}%")

    reps = representative_points(grid, polygon, sectors)
    max_shift = 0.0
    rollout_cases = 0
    rollout_redirected = 0
    rollout_off_green = 0
    rollout_preservation_error = 0.0
    for _label, pin in reps:
        target, shift = targeting_shift(grid, polygon, pin)
        max_shift = max(max_shift, shift)
        if shift > 5.0001:
            errors.append(f"target shift exceeded 5 yd cap: {shift:.3f}")
        if not point_in_polygon(target, polygon):
            errors.append("target shift left the green polygon")
        for angle_deg in (0, 45, 90, 135, 180, 225, 270, 315):
            angle = math.radians(angle_deg)
            baseline = (pin[0] + math.sin(angle) * 5.0, pin[1] + math.cos(angle) * 5.0)
            landing, applied, _blend = redirect_rollout(grid, pin, baseline)
            rollout_cases += 1
            rollout_redirected += int(applied)
            if applied and not point_in_polygon(landing, polygon):
                rollout_off_green += 1
            original_length = math.hypot(baseline[0] - pin[0], baseline[1] - pin[1])
            redirected_length = math.hypot(landing[0] - pin[0], landing[1] - pin[1])
            rollout_preservation_error = max(rollout_preservation_error, abs(original_length - redirected_length))
    if rollout_preservation_error > 1e-6:
        errors.append(f"rollout distance changed by up to {rollout_preservation_error:.6f} yd")
    if max_shift > 4.9:
        warnings.append(f"representative target reached near-max shift ({max_shift:.1f} yd)")
    off_green_rate = rollout_off_green / rollout_redirected if rollout_redirected else 0.0
    if rollout_redirected and off_green_rate > 0.35:
        warnings.append(f"{off_green_rate:.0%} of redirected representative rollouts finish off green")

    summary = raw.get("greenSummary") if isinstance(raw.get("greenSummary"), dict) else {}
    return {
        "hole": hole_number,
        "coverage": round(coverage, 4),
        "greenSampleCount": int(raw.get("greenSampleCount") or 0),
        "elevationRangeFt": summary.get("elevationRangeFt"),
        "planeSlopePercent": summary.get("planeSlopePercent"),
        "populatedSectors": populated_sectors,
        "p95NodeJumpFt": round(p95_jump, 3),
        "maxNodeJumpFt": round(max_jump, 3),
        "p95SmoothedSlopePercent": round(p95_slope, 2),
        "maxSmoothedSlopePercent": round(max_slope, 2),
        "representativePins": len(reps),
        "maxRepresentativeTargetShiftYds": round(max_shift, 2),
        "redirectedRolloutCases": rollout_redirected,
        "redirectedOffGreenCases": rollout_off_green,
        "warnings": warnings,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-slug", default="greywolf")
    parser.add_argument("--package", type=Path)
    parser.add_argument("--geometry-dir", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    package_path = args.package or Path(f"public/course-geometry/{args.course_slug}/green-detail-v1.json")
    geometry_dir = args.geometry_dir or Path(f"public/course-geometry/{args.course_slug}/local-geometry")
    package = json.loads(package_path.read_text(encoding="utf-8"))
    if package.get("schemaVersion") not in {"looper-greywolf-green-detail-v1", "looper-course-green-detail-v1"}:
        raise SystemExit(f"Unsupported green detail schema: {package.get('schemaVersion')!r}")
    holes = package.get("holes")
    if not isinstance(holes, dict):
        raise SystemExit("Green detail package has no holes object")
    nodata = int((package.get("runtimeTerrain") or {}).get("nodata", NODATA_DEFAULT))

    results = []
    for hole_number in range(1, 19):
        raw = holes.get(str(hole_number))
        if not isinstance(raw, dict):
            results.append({"hole": hole_number, "warnings": [], "errors": ["missing green detail hole"]})
            continue
        polygon = target_green_polygon(geometry_dir / f"{args.course_slug}-hole-{hole_number:02d}.json")
        try:
            results.append(audit_hole(hole_number, raw, polygon, nodata))
        except Exception as exc:  # keep coursewide diagnostics even when one hole breaks
            results.append({"hole": hole_number, "warnings": [], "errors": [f"audit exception: {exc}"]})

    warnings = [(row["hole"], warning) for row in results for warning in row.get("warnings", [])]
    errors = [(row["hole"], error) for row in results for error in row.get("errors", [])]
    report = {
        "schemaVersion": "looper-green-detail-audit-v1",
        "courseSlug": args.course_slug,
        "packageSchema": package.get("schemaVersion"),
        "holeCount": len(results),
        "warningCount": len(warnings),
        "errorCount": len(errors),
        "holes": results,
    }

    print("Green detail audit")
    print("hole cov  elevRange  p95Slope  maxJump  sectors  maxShift  redir/off  status")
    for row in results:
        if "coverage" not in row:
            print(f"H{row['hole']:02d}  --   --         --        --       --       --        --        ERROR")
            continue
        status = "ERROR" if row["errors"] else "WARN" if row["warnings"] else "OK"
        print(
            f"H{row['hole']:02d}  {row['coverage']*100:4.0f}% "
            f"{float(row.get('elevationRangeFt') or 0):8.1f}ft "
            f"{row['p95SmoothedSlopePercent']:7.1f}% "
            f"{row['maxNodeJumpFt']:7.2f}ft "
            f"{row['populatedSectors']:2d}/9 "
            f"{row['maxRepresentativeTargetShiftYds']:7.1f}yd "
            f"{row['redirectedRolloutCases']:3d}/{row['redirectedOffGreenCases']:<3d}  {status}"
        )
    if warnings:
        print("\nWarnings:")
        for hole, warning in warnings:
            print(f"  H{hole:02d}: {warning}")
    if errors:
        print("\nErrors:")
        for hole, error in errors:
            print(f"  H{hole:02d}: {error}")

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
