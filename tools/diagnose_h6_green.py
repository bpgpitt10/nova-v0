#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import statistics
from pathlib import Path

from audit_green_detail import Grid, nearest_boundary, point_in_polygon, smoothed_slope, target_green_polygon, percentile

COURSE = Path('public/course-geometry/greywolf')
DETAIL = COURSE / 'green-detail-v1.json'
GEOMETRY = COURSE / 'local-geometry/greywolf-hole-06.json'


def sector_for(point, sectors):
    x, y = point
    for sector in sectors:
        bounds = sector.get('boundsYds')
        if isinstance(bounds, list) and len(bounds) == 4:
            if bounds[0] <= x <= bounds[1] and bounds[2] <= y <= bounds[3]:
                return str(sector.get('id') or 'unknown')
    return 'none'


def fmt_point(point):
    return f'({point[0]:6.1f} R, {point[1]:6.1f} F)'


def solve_3x3(matrix, vector):
    a = [list(row) + [rhs] for row, rhs in zip(matrix, vector)]
    for col in range(3):
        pivot = max(range(col, 3), key=lambda row: abs(a[row][col]))
        if abs(a[pivot][col]) < 1e-10:
            return None
        a[col], a[pivot] = a[pivot], a[col]
        scale = a[col][col]
        a[col] = [value / scale for value in a[col]]
        for row in range(3):
            if row == col:
                continue
            factor = a[row][col]
            a[row] = [a[row][idx] - factor * a[col][idx] for idx in range(4)]
    return a[0][3], a[1][3], a[2][3]


def fit_plane(samples):
    # z_ft = ax*x_yd + by*y_yd + c. Grade percent converts yd horizontal to ft.
    if len(samples) < 3:
        return None
    sx = sum(point[0] for point, _z, _edge in samples)
    sy = sum(point[1] for point, _z, _edge in samples)
    sz = sum(z for _point, z, _edge in samples)
    sxx = sum(point[0] * point[0] for point, _z, _edge in samples)
    syy = sum(point[1] * point[1] for point, _z, _edge in samples)
    sxy = sum(point[0] * point[1] for point, _z, _edge in samples)
    sxz = sum(point[0] * z for point, z, _edge in samples)
    syz = sum(point[1] * z for point, z, _edge in samples)
    n = float(len(samples))
    solved = solve_3x3(
        [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]],
        [sxz, syz, sz],
    )
    if solved is None:
        return None
    ax, by, intercept = solved
    residuals = [z - (ax * point[0] + by * point[1] + intercept) for point, z, _edge in samples]
    rms = math.sqrt(sum(value * value for value in residuals) / len(residuals))
    median_abs = statistics.median(abs(value) for value in residuals)
    max_abs = max(abs(value) for value in residuals)
    slope_percent = math.hypot(ax, by) / 3.0 * 100.0
    downhill = (-ax, -by)
    downhill_len = math.hypot(*downhill)
    downhill_unit = (downhill[0] / downhill_len, downhill[1] / downhill_len) if downhill_len > 1e-9 else (0.0, 0.0)
    return {
        'n': len(samples),
        'slope': slope_percent,
        'rms': rms,
        'median_abs': median_abs,
        'max_abs': max_abs,
        'downhill': downhill_unit,
    }


def samples_for_sector(nodes, sector, min_edge=0.0):
    bounds = sector.get('boundsYds')
    if not isinstance(bounds, list) or len(bounds) != 4:
        return []
    return [
        (point, z, edge)
        for point, z, edge, _row, _col in nodes
        if edge >= min_edge
        and bounds[0] <= point[0] <= bounds[1]
        and bounds[2] <= point[1] <= bounds[3]
    ]


def main():
    package = json.loads(DETAIL.read_text(encoding='utf-8-sig'))
    raw = package['holes']['6']
    grid = Grid(raw, int(package['runtimeTerrain'].get('nodata', 65535)))
    polygon = target_green_polygon(GEOMETRY)
    sectors = raw.get('sectors') or []

    nodes = []
    jumps = []
    slopes = []
    residuals = []

    for row in range(grid.height):
        for col in range(grid.width):
            point = grid.point(row, col)
            if not point_in_polygon(point, polygon):
                continue
            z = grid.node(row, col)
            if z is None:
                continue
            edge = nearest_boundary(point, polygon)
            edge_dist = edge[0] if edge else math.inf
            nodes.append((point, z, edge_dist, row, col))

            slope = smoothed_slope(grid, point)
            if slope:
                slopes.append((slope[0], point, edge_dist, sector_for(point, sectors)))

            neigh = []
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr == 0 and dc == 0:
                        continue
                    nz = grid.node(row + dr, col + dc)
                    np = grid.point(row + dr, col + dc)
                    if nz is not None and point_in_polygon(np, polygon):
                        neigh.append(nz)
            if len(neigh) >= 4:
                residuals.append((abs(z - statistics.median(neigh)), point, z, statistics.median(neigh), edge_dist, sector_for(point, sectors)))

            for dr, dc in ((0, 1), (1, 0)):
                nr, nc = row + dr, col + dc
                nz = grid.node(nr, nc)
                if nz is None:
                    continue
                np = grid.point(nr, nc)
                if not point_in_polygon(np, polygon):
                    continue
                nedge = nearest_boundary(np, polygon)
                nedge_dist = nedge[0] if nedge else math.inf
                jumps.append((abs(nz - z), point, np, z, nz, min(edge_dist, nedge_dist), sector_for(point, sectors)))

    elevations = [z for _, z, _, _, _ in nodes]
    print('Greywolf H06 focused terrain diagnostic')
    print(f'grid={grid.width}x{grid.height} spacing={grid.spacing:.2f} yd inside_nodes={len(nodes)}')
    print(f'elevation min={min(elevations):.2f} ft max={max(elevations):.2f} ft range={max(elevations)-min(elevations):.2f} ft median={statistics.median(elevations):.2f} ft')
    print(f'green plane slope={float(raw["greenSummary"]["planeSlopePercent"]):.1f}%')

    print('\nSlope by distance from actual green boundary')
    for label, low in [('all', 0.0), ('>=1yd', 1.0), ('>=2yd', 2.0), ('>=3yd', 3.0), ('>=5yd', 5.0)]:
        vals = [s for s, _, d, _ in slopes if d >= low]
        if vals:
            print(f'{label:6s} n={len(vals):3d} p50={percentile(vals,0.50):5.1f}% p95={percentile(vals,0.95):5.1f}% max={max(vals):5.1f}%')

    print('\n1 yd elevation jump by distance from actual green boundary')
    for label, low in [('all', 0.0), ('>=1yd', 1.0), ('>=2yd', 2.0), ('>=3yd', 3.0), ('>=5yd', 5.0)]:
        vals = [j for j, *_rest, d, _sector in jumps if d >= low]
        if vals:
            print(f'{label:6s} n={len(vals):3d} p95={percentile(vals,0.95):4.2f} ft max={max(vals):4.2f} ft')

    print('\nSector plane quality: stored vs refit to actual on-green grid nodes')
    print('sector         stored  nStored  refit(all) rms/max   refit(>=2y) rms/max   refit(>=5y) rms/max')
    for sector in sectors:
        fits = [fit_plane(samples_for_sector(nodes, sector, edge)) for edge in (0.0, 2.0, 5.0)]
        def fit_text(fit):
            if not fit:
                return '   n/a'
            return f'{fit["slope"]:5.1f}% n={fit["n"]:3d} {fit["rms"]:3.1f}/{fit["max_abs"]:3.1f}'
        print(
            f'{str(sector.get("id")):14s} '
            f'{float(sector.get("planeSlopePercent") or 0):6.1f}% '
            f'{int(sector.get("sampleCount") or 0):7d}  '
            f'{fit_text(fits[0]):20s} {fit_text(fits[1]):20s} {fit_text(fits[2]):20s}'
        )

    print('\nTop 12 raw 1 yd jumps')
    for jump, a, b, za, zb, edge_dist, sector in sorted(jumps, reverse=True)[:12]:
        print(f'{jump:4.2f} ft  {fmt_point(a)} {za:7.2f} -> {fmt_point(b)} {zb:7.2f}  edge={edge_dist:4.1f} yd  sector={sector}')

    print('\nTop 12 smoothed slopes')
    for slope, point, edge_dist, sector in sorted(slopes, reverse=True)[:12]:
        print(f'{slope:6.1f}%  {fmt_point(point)}  edge={edge_dist:4.1f} yd  sector={sector}')

    print('\nTop 12 local-node residuals vs median of neighboring on-green nodes')
    for residual, point, z, med, edge_dist, sector in sorted(residuals, reverse=True)[:12]:
        print(f'{residual:4.2f} ft  {fmt_point(point)} z={z:7.2f} localMed={med:7.2f} edge={edge_dist:4.1f} yd sector={sector}')

    severe_slopes = [(s, p, d) for s, p, d, _ in slopes if s >= 20]
    severe_jumps = [(j, a, b, d) for j, a, b, *_mid, d, _ in jumps if j >= 1.5]
    interior_severe_slopes = [item for item in severe_slopes if item[2] >= 3.0]
    interior_severe_jumps = [item for item in severe_jumps if item[3] >= 3.0]
    print('\nConcentration test')
    print(f'slope>=20%: {len(severe_slopes)} total; {len(interior_severe_slopes)} at least 3 yd inside green')
    print(f'jump>=1.5ft/yd: {len(severe_jumps)} total; {len(interior_severe_jumps)} at least 3 yd inside green')

    if jumps:
        worst = max(jumps, key=lambda item: item[0])
        anchor = worst[1]
        c = round((anchor[0] - grid.min_x) / grid.spacing)
        r = round((anchor[1] - grid.min_y) / grid.spacing)
        print('\n5x5 elevation patch around worst jump anchor (ft; -- = off-grid/nodata)')
        for rr in range(r - 2, r + 3):
            row_vals = []
            for cc in range(c - 2, c + 3):
                val = grid.node(rr, cc)
                row_vals.append('--' if val is None else f'{val:.1f}')
            print(' '.join(f'{v:>7s}' for v in row_vals))


if __name__ == '__main__':
    main()
