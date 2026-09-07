from __future__ import annotations
import math
from .models import PointYards

def point_segment_distance(p: PointYards, a: PointYards, b: PointYards) -> float:
    vx, vy = b.forward - a.forward, b.right - a.right
    wx, wy = p.forward - a.forward, p.right - a.right
    denom = vx * vx + vy * vy
    if denom <= 1e-12:
        return math.hypot(wx, wy)
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    qx, qy = a.forward + t * vx, a.right + t * vy
    return math.hypot(p.forward - qx, p.right - qy)

def point_polyline_distance(p: PointYards, points: list[PointYards]) -> float | None:
    if len(points) < 2:
        return None
    return min(point_segment_distance(p, a, b) for a, b in zip(points, points[1:]))

def point_in_polygon(p: PointYards, polygon: list[PointYards]) -> bool:
    if len(polygon) < 3:
        return False
    inside = False
    x, y = p.forward, p.right
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i].forward, polygon[i].right
        xj, yj = polygon[j].forward, polygon[j].right
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside

def unit_and_cross(target: PointYards) -> tuple[PointYards, PointYards]:
    """Return along-shot unit vector and its player's-right cross-track vector."""
    norm = math.hypot(target.forward, target.right)
    if norm <= 1e-9:
        return PointYards(1.0, 0.0), PointYards(0.0, 1.0)
    unit = PointYards(target.forward / norm, target.right / norm)
    cross = PointYards(-unit.right, unit.forward)
    return unit, cross

def add_scaled(origin: PointYards, direction: PointYards, amount: float) -> PointYards:
    return PointYards(
        origin.forward + direction.forward * float(amount),
        origin.right + direction.right * float(amount),
    )

def gaussian_pattern_samples(
    center: PointYards,
    carry_sigma: float,
    lateral_sigma: float,
    extent: float = 2.0,
    *,
    shot_unit: PointYards | None = None,
    cross_unit: PointYards | None = None,
):
    """Deterministic Gaussian sample in shot-relative carry/cross-track coordinates.

    The old implementation treated carry dispersion as canonical-map forward and
    lateral dispersion as canonical-map right. That is only correct when the shot
    aims exactly along the tee-to-pin axis. Strategic GSPro targets can be far off
    that axis, so the pattern must rotate with the intended shot direction.
    """
    if shot_unit is None or cross_unit is None:
        shot_unit, cross_unit = PointYards(1.0, 0.0), PointYards(0.0, 1.0)
    zs = (-extent, -1.0, 0.0, 1.0, extent)
    out = []
    total = 0.0
    for zf in zs:
        for zr in zs:
            weight = math.exp(-0.5 * (zf * zf + zr * zr))
            total += weight
            point = PointYards(
                center.forward
                + zf * carry_sigma * shot_unit.forward
                + zr * lateral_sigma * cross_unit.forward,
                center.right
                + zf * carry_sigma * shot_unit.right
                + zr * lateral_sigma * cross_unit.right,
            )
            out.append((point, weight))
    return [(point, weight / total) for point, weight in out]
