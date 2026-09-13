#!/usr/bin/env python3
"""Pure geometry/risk primitives for Looper screenshot-first strategy work.

This module deliberately does NOT choose a club or recommend an aim point. It
evaluates a supplied landing distribution against trusted screenshot geometry.

Area hazards (currently bunkers) can produce probability-mass estimates.
Boundary hazards (red penalty / white OB lines) only produce clearance and
ellipse-intersection evidence until Looper knows which side of the line is unsafe.
"""
from __future__ import annotations

import math
from statistics import NormalDist
from typing import Any, Iterable

SCHEMA_VERSION = "looper-strategy-risk-v0"
DEFAULT_SAMPLE_COUNT = 2048
AREA_CLASSES = {"bunker"}
BOUNDARY_CLASSES = {"penalty_area", "out_of_bounds"}


def _finite(value: Any, name: str) -> float:
    out = float(value)
    if not math.isfinite(out):
        raise ValueError(f"{name} must be finite")
    return out


def pixel_to_local(transform: dict[str, Any], x: float, y: float) -> tuple[float, float]:
    tee = transform.get("tee_pixel") or {}
    pin = transform.get("pin_pixel") or {}
    scale = _finite(transform.get("yards_per_pixel"), "yards_per_pixel")
    if scale <= 0:
        raise ValueError("yards_per_pixel must be > 0")
    tx, ty = _finite(tee.get("x"), "tee.x"), _finite(tee.get("y"), "tee.y")
    px, py = _finite(pin.get("x"), "pin.x"), _finite(pin.get("y"), "pin.y")
    dx, dy = px - tx, py - ty
    dist = math.hypot(dx, dy)
    if dist <= 1e-9:
        raise ValueError("tee and pin pixels coincide")
    fx, fy = dx / dist, dy / dist
    # Image x-right/y-down: golfer-right is (-fy,+fx).
    rx, ry = -fy, fx
    qx, qy = float(x) - tx, float(y) - ty
    return (qx * rx + qy * ry) * scale, (qx * fx + qy * fy) * scale


def geometry_local_layers(payload: dict[str, Any]) -> list[dict[str, Any]]:
    transform = payload.get("coordinate_transform") or {}
    rows: list[dict[str, Any]] = []
    for item in payload.get("precise_pixel_geometry") or []:
        cls = str(item.get("hazard_class") or "")
        if cls not in AREA_CLASSES | BOUNDARY_CLASSES:
            continue
        points = item.get("polygon_pixel")
        if not isinstance(points, list) or len(points) < 2:
            continue
        local = []
        valid = True
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                valid = False
                break
            try:
                lat, fwd = pixel_to_local(transform, point[0], point[1])
            except Exception:
                valid = False
                break
            local.append([lat, fwd])
        if not valid or len(local) < 2:
            continue
        rows.append({
            "hazard_class": cls,
            "source": item.get("source"),
            "source_object_id": item.get("source_object_id"),
            "geometry_role": "area" if cls in AREA_CLASSES else "boundary",
            "points_local_yards": local,
            "strategy_authority": False,
        })
    return rows


def covariance_from_profile(profile: dict[str, Any]) -> tuple[tuple[float, float], tuple[float, float]]:
    if isinstance(profile.get("covariance"), (list, tuple)):
        raw = profile["covariance"]
        if len(raw) != 2 or any(not isinstance(row, (list, tuple)) or len(row) != 2 for row in raw):
            raise ValueError("covariance must be a 2x2 matrix")
        a, b = _finite(raw[0][0], "cov[0][0]"), _finite(raw[0][1], "cov[0][1]")
        c, d = _finite(raw[1][0], "cov[1][0]"), _finite(raw[1][1], "cov[1][1]")
        if abs(b - c) > 1e-8:
            raise ValueError("covariance must be symmetric")
    else:
        sl = _finite(profile.get("sigma_lateral_yds"), "sigma_lateral_yds")
        sf = _finite(profile.get("sigma_forward_yds"), "sigma_forward_yds")
        rho = _finite(profile.get("correlation", 0.0), "correlation")
        if sl <= 0 or sf <= 0:
            raise ValueError("shot sigmas must be > 0")
        if not -0.999 < rho < 0.999:
            raise ValueError("correlation must be between -0.999 and 0.999")
        a, d = sl * sl, sf * sf
        b = c = rho * sl * sf
    det = a * d - b * c
    if a <= 0 or d <= 0 or det <= 1e-12:
        raise ValueError("covariance must be positive definite")
    return ((a, b), (c, d))


def _inverse_2x2(cov: tuple[tuple[float, float], tuple[float, float]]):
    a, b = cov[0]
    c, d = cov[1]
    det = a * d - b * c
    return ((d / det, -b / det), (-c / det, a / det))


def _cholesky_2x2(cov: tuple[tuple[float, float], tuple[float, float]]):
    a, b = cov[0]
    _, d = cov[1]
    l11 = math.sqrt(a)
    l21 = b / l11
    rem = d - l21 * l21
    if rem <= 0:
        raise ValueError("covariance is not positive definite")
    return ((l11, 0.0), (l21, math.sqrt(rem)))


def _quad(vx: float, vy: float, matrix) -> float:
    return vx * (matrix[0][0] * vx + matrix[0][1] * vy) + vy * (matrix[1][0] * vx + matrix[1][1] * vy)


def _point_in_polygon(x: float, y: float, polygon: list[list[float]]) -> bool:
    if len(polygon) < 3:
        return False
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if (yi > y) != (yj > y):
            xcross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xcross:
                inside = not inside
        j = i
    return inside


def _segment_euclidean_distance(point: tuple[float, float], a, b) -> float:
    px, py = point
    ax, ay = float(a[0]), float(a[1])
    bx, by = float(b[0]), float(b[1])
    vx, vy = bx - ax, by - ay
    denom = vx * vx + vy * vy
    if denom <= 1e-12:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / denom))
    qx, qy = ax + t * vx, ay + t * vy
    return math.hypot(px - qx, py - qy)


def _segment_min_mahalanobis_sq(mean: tuple[float, float], a, b, invcov) -> float:
    ax, ay = float(a[0]) - mean[0], float(a[1]) - mean[1]
    vx, vy = float(b[0]) - float(a[0]), float(b[1]) - float(a[1])
    av = ax * (invcov[0][0] * vx + invcov[0][1] * vy) + ay * (invcov[1][0] * vx + invcov[1][1] * vy)
    vv = _quad(vx, vy, invcov)
    t = 0.0 if vv <= 1e-12 else max(0.0, min(1.0, -av / vv))
    qx, qy = ax + t * vx, ay + t * vy
    return max(0.0, _quad(qx, qy, invcov))


def _poly_segments(points: list[list[float]], closed: bool):
    limit = len(points) if closed else len(points) - 1
    for i in range(max(0, limit)):
        yield points[i], points[(i + 1) % len(points)]


def _halton(index: int, base: int) -> float:
    result = 0.0
    f = 1.0 / base
    i = index
    while i > 0:
        result += f * (i % base)
        i //= base
        f /= base
    return result


def gaussian_samples(mean: tuple[float, float], cov, count: int = DEFAULT_SAMPLE_COUNT) -> list[tuple[float, float]]:
    if count < 32:
        raise ValueError("sample count must be >= 32")
    chol = _cholesky_2x2(cov)
    normal = NormalDist()
    out = []
    for i in range(1, count + 1):
        u1 = min(1 - 1e-12, max(1e-12, _halton(i, 2)))
        u2 = min(1 - 1e-12, max(1e-12, _halton(i, 3)))
        z1, z2 = normal.inv_cdf(u1), normal.inv_cdf(u2)
        x = mean[0] + chol[0][0] * z1
        y = mean[1] + chol[1][0] * z1 + chol[1][1] * z2
        out.append((x, y))
    return out


def contour_radius_sq(probability: float) -> float:
    p = float(probability)
    if not 0.0 < p < 1.0:
        raise ValueError("probability must be in (0,1)")
    # Chi-square CDF with df=2 is 1-exp(-x/2).
    return -2.0 * math.log(1.0 - p)


def evaluate_target(
    geometry_payload: dict[str, Any],
    *,
    center_lateral_yds: float,
    center_forward_yds: float,
    shot_profile: dict[str, Any],
    sample_count: int = DEFAULT_SAMPLE_COUNT,
    contour_probabilities: Iterable[float] = (0.80, 0.95),
) -> dict[str, Any]:
    mean = (_finite(center_lateral_yds, "center_lateral_yds"), _finite(center_forward_yds, "center_forward_yds"))
    cov = covariance_from_profile(shot_profile)
    invcov = _inverse_2x2(cov)
    layers = geometry_local_layers(geometry_payload)
    samples = gaussian_samples(mean, cov, sample_count)
    contour_ps = [float(p) for p in contour_probabilities]
    contour_q = {p: contour_radius_sq(p) for p in contour_ps}

    hazards = []
    total_bunker_hits: set[int] = set()
    for idx, layer in enumerate(layers):
        cls = layer["hazard_class"]
        points = layer["points_local_yards"]
        closed = cls in AREA_CLASSES
        segments = list(_poly_segments(points, closed=closed))
        min_clearance = min((_segment_euclidean_distance(mean, a, b) for a, b in segments), default=None)
        min_d2 = min((_segment_min_mahalanobis_sq(mean, a, b, invcov) for a, b in segments), default=float("inf"))
        center_inside = _point_in_polygon(mean[0], mean[1], points) if closed else False
        contour_intersection = {
            f"{int(round(p * 100))}pct": bool(center_inside or min_d2 <= q)
            for p, q in contour_q.items()
        }
        record = {
            "hazard_index": idx,
            "hazard_class": cls,
            "source": layer.get("source"),
            "source_object_id": layer.get("source_object_id"),
            "geometry_role": layer["geometry_role"],
            "center_clearance_yds": min_clearance,
            "mahalanobis_clearance_sigma": math.sqrt(min_d2) if math.isfinite(min_d2) else None,
            "ellipse_intersects_boundary": contour_intersection,
            "strategy_authority": False,
        }
        if cls in AREA_CLASSES:
            hits = {i for i, (x, y) in enumerate(samples) if _point_in_polygon(x, y, points)}
            total_bunker_hits.update(hits)
            record["estimated_landing_probability"] = len(hits) / len(samples)
            record["center_inside_hazard"] = center_inside
        else:
            # A line alone does not tell us which side is unsafe, so do not invent
            # a penalty/OB probability.
            record["estimated_landing_probability"] = None
            record["probability_unavailable_reason"] = "boundary-side orientation is not yet known"
        hazards.append(record)

    return {
        "schema_version": SCHEMA_VERSION,
        "target_center_local_yards": {"lateral": mean[0], "forward": mean[1]},
        "shot_profile": {
            "covariance_local_yards2": [list(cov[0]), list(cov[1])],
            "sample_count": len(samples),
        },
        "hazard_evidence": hazards,
        "aggregate": {
            "estimated_any_bunker_probability": len(total_bunker_hits) / len(samples),
            "boundary_probability_available": False,
            "boundary_probability_note": "Penalty/OB lines support clearance + ellipse intersection only until unsafe-side orientation is known.",
        },
        "strategy_authority": False,
        "recommendation": None,
    }


def evaluate_lateral_candidates(
    geometry_payload: dict[str, Any],
    *,
    forward_yds: float,
    lateral_offsets_yds: Iterable[float],
    shot_profile: dict[str, Any],
    sample_count: int = DEFAULT_SAMPLE_COUNT,
) -> list[dict[str, Any]]:
    return [
        evaluate_target(
            geometry_payload,
            center_lateral_yds=float(lateral),
            center_forward_yds=float(forward_yds),
            shot_profile=shot_profile,
            sample_count=sample_count,
        )
        for lateral in lateral_offsets_yds
    ]
