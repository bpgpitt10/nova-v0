#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path

from audit_green_detail import Grid, nearest_boundary, percentile, point_in_polygon, target_green_polygon

COURSE = Path('public/course-geometry/greywolf')
DETAIL = COURSE / 'green-detail-v1.json'
GEOMETRY = COURSE / 'local-geometry'
RADIUS_YDS = 3.0


def solve_local_plane(samples):
    if len(samples) < 8:
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
    det = sxx * syy - sxy * sxy
    if abs(det) < 1e-9:
        return None
    a = (sxz * syy - syz * sxy) / det
    b = (syz * sxx - sxz * sxy) / det
    residuals = [z - (mz + a * (x - mx) + b * (y - my)) for x, y, z in samples]
    rms = math.sqrt(statistics.fmean(value * value for value in residuals))
    return {
        'n': len(samples),
        'slope': math.hypot(a, b) / 3.0 * 100.0,
        'rms': rms,
        'max_residual': max(abs(value) for value in residuals),
    }


def analyze_hole(package, hole_number):
    raw = package['holes'][str(hole_number)]
    grid = Grid(raw, int(package['runtimeTerrain'].get('nodata', 65535)))
    polygon = target_green_polygon(GEOMETRY / f'greywolf-hole-{hole_number:02d}.json')
    nodes = []
    for row in range(grid.height):
        for col in range(grid.width):
            point = grid.point(row, col)
            z = grid.node(row, col)
            if z is None or not point_in_polygon(point, polygon):
                continue
            edge = nearest_boundary(point, polygon)
            nodes.append((row, col, point, z, edge[0] if edge else math.inf))

    node_lookup = {(row, col): (point, z) for row, col, point, z, _edge in nodes}
    fits = []
    radius_cells = max(1, round(RADIUS_YDS / grid.spacing))
    for row, col, point, _z, edge in nodes:
        samples = []
        for rr in range(row - radius_cells, row + radius_cells + 1):
            for cc in range(col - radius_cells, col + radius_cells + 1):
                item = node_lookup.get((rr, cc))
                if item is None:
                    continue
                sample_point, sample_z = item
                if math.hypot(sample_point[0] - point[0], sample_point[1] - point[1]) <= RADIUS_YDS + 1e-9:
                    samples.append((sample_point[0], sample_point[1], sample_z))
        fit = solve_local_plane(samples)
        if fit:
            fits.append((fit, point, edge))

    rms_values = [fit['rms'] for fit, _point, _edge in fits]
    print(f'H{hole_number:02d} nodes={len(nodes)} fits={len(fits)} whole={raw["greenSummary"]["planeSlopePercent"]:.1f}%')
    if not fits:
        return
    print(
        '  local RMS ft: '
        f'p50={percentile(rms_values, .50):.2f} '
        f'p90={percentile(rms_values, .90):.2f} '
        f'p95={percentile(rms_values, .95):.2f} '
        f'max={max(rms_values):.2f}'
    )
    for threshold in (0.20, 0.35, 0.50, 0.75):
        clean = [(fit, point, edge) for fit, point, edge in fits if fit['rms'] <= threshold]
        slopes = [fit['slope'] for fit, _point, _edge in clean]
        if not slopes:
            continue
        steep = [(fit, point, edge) for fit, point, edge in clean if fit['slope'] >= 12.0]
        print(
            f'  rms<={threshold:.2f}: {len(clean):4d}/{len(fits)} '
            f'slope p50={percentile(slopes,.50):5.1f}% p95={percentile(slopes,.95):5.1f}% max={max(slopes):5.1f}% '
            f'clean>=12%={len(steep)}'
        )
    clean_steep = sorted(
        [(fit, point, edge) for fit, point, edge in fits if fit['rms'] <= 0.35 and fit['slope'] >= 12.0],
        key=lambda item: item[0]['slope'],
        reverse=True,
    )
    for fit, point, edge in clean_steep[:5]:
        print(
            f'    steep-clean {fit["slope"]:5.1f}% rms={fit["rms"]:.2f} '
            f'n={fit["n"]:2d} at ({point[0]:.1f}R,{point[1]:.1f}F) edge={edge:.1f}yd'
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--hole', type=int)
    args = parser.parse_args()
    package = json.loads(DETAIL.read_text(encoding='utf-8-sig'))
    holes = [args.hole] if args.hole else list(range(1, 19))
    for hole in holes:
        analyze_hole(package, hole)


if __name__ == '__main__':
    main()
