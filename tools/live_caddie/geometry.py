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

def gaussian_pattern_samples(center: PointYards, carry_sigma: float, lateral_sigma: float, extent: float = 2.0):
    # Stable deterministic approximation used for ranking, not an exact probability claim.
    zs = (-extent, -1.0, 0.0, 1.0, extent)
    out = []
    total = 0.0
    for zf in zs:
        for zr in zs:
            weight = math.exp(-0.5 * (zf * zf + zr * zr))
            total += weight
            out.append((PointYards(center.forward + zf * carry_sigma, center.right + zr * lateral_sigma), weight))
    return [(point, weight / total) for point, weight in out]
