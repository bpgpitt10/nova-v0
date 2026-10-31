#!/usr/bin/env python3
"""Register GSPro world coordinates to real ground by matching heights.

Green centroids can't register a course better than ~3.5 m because an OSM
polygon centroid is not the designer's green centre. Heights are a different
class of evidence: if GSPro terrain was built from the same LiDAR, every GKD
point with a height (pins, penalty-area and OB vertices, logged shots) must sit
on the DEM once the horizontal transform is right, and slopes make horizontal
error visible as vertical error.

Model: UTM16N (E, N) = s * R(theta) * (x, z) + (tE, tN);  ground = y + dy.
Start from the green-centroid similarity fit, search translation on a grid,
then refine all parameters with a robust (trimmed) cost. Report residuals by
point group, an east/west split-half check, and a grade.

Runs locally on the player's copy of the GKD; outputs contain only the fitted
transform and residual statistics, never GKD geometry.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gkd_native as gkd  # noqa: E402
from grid_io import load_grid  # noqa: E402




def utm(lat: float, lon: float, zone: int) -> tuple[float, float]:
    """GRS80 transverse Mercator (Kruger series), UTM zone N (NAD83 / WGS84 north)."""
    a, f = 6378137.0, 1 / 298.257222101
    n = f / (2 - f)
    A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64)
    al = [0, n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240]
    e = math.sqrt(f * (2 - f))
    lon0 = -183.0 + 6.0 * zone
    phi, lam = math.radians(lat), math.radians(lon - lon0)
    t = math.sinh(math.atanh(math.sin(phi)) - e * math.atanh(e * math.sin(phi)))
    xi = math.atan2(t, math.cos(lam))
    eta = math.atanh(math.sin(lam) / math.sqrt(1 + t * t))
    E = eta + sum(al[j] * math.cos(2 * j * xi) * math.sinh(2 * j * eta) for j in (1, 2, 3))
    N = xi + sum(al[j] * math.sin(2 * j * xi) * math.cosh(2 * j * eta) for j in (1, 2, 3))
    return 500000 + 0.9996 * A * E, 0.9996 * A * N


def utm16n(lat: float, lon: float) -> tuple[float, float]:
    return utm(lat, lon, 16)


def utm_zone_from_crs(crs: str) -> int:
    """'EPSG:26916' (NAD83) or 'EPSG:32616' (WGS84) -> 16."""
    code = int(str(crs).split(':')[-1])
    if 26901 <= code <= 26923:
        return code - 26900
    if 32601 <= code <= 32660:
        return code - 32600
    raise ValueError(f'not a northern UTM CRS: {crs}')


def utm_convergence_scale(lat: float, lon: float, lon0: float = -87.0, k0: float = 0.9996) -> tuple[float, float]:
    """Grid convergence (radians) and point scale of UTM at a location.

    A true-north ground-metre frame maps into UTM rotated by the convergence
    and scaled by the point scale.
    """
    dl = math.radians(lon - lon0)
    phi = math.radians(lat)
    c2 = math.cos(phi) ** 2
    gamma = dl * math.sin(phi) * (1 + dl * dl * c2 / 3)
    k = k0 * (1 + dl * dl * c2 / 2)
    return gamma, k


def similarity(src: np.ndarray, dst: np.ndarray) -> tuple[float, float, np.ndarray]:
    ms, md = src.mean(0), dst.mean(0)
    s0, d0 = src - ms, dst - md
    dot = (s0 * d0).sum()
    cross = (s0[:, 0] * d0[:, 1] - s0[:, 1] * d0[:, 0]).sum()
    theta = math.atan2(cross, dot)
    scale = math.hypot(dot, cross) / (s0 ** 2).sum()
    R = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    return scale, theta, md - scale * R @ ms


def apply(params, xz: np.ndarray) -> np.ndarray:
    tE, tN, theta, s = params
    c, si = math.cos(theta), math.sin(theta)
    return np.column_stack([s * (c * xz[:, 0] - si * xz[:, 1]) + tE,
                            s * (si * xz[:, 0] + c * xz[:, 1]) + tN])


class Dem:
    def __init__(self, header_path: Path):
        self.h, self.z = load_grid(header_path)

    def sample(self, en: np.ndarray) -> np.ndarray:
        from scipy.ndimage import map_coordinates
        px = self.h['pixelSize']
        cols = (en[:, 0] - self.h['originX']) / px - 0.5
        rows = (self.h['originY'] - en[:, 1]) / px - 0.5
        z = np.nan_to_num(self.z, nan=-1e4)
        out = map_coordinates(z, [rows, cols], order=1, mode='constant', cval=-1e4)
        out[out < -1e3] = np.nan
        return out


def residuals(params, dem: Dem, pts: np.ndarray) -> tuple[np.ndarray, float]:
    ground = dem.sample(apply(params, pts[:, [0, 2]]))
    r = ground - pts[:, 1]
    dy = float(np.nanmedian(r))
    return r - dy, dy


def cost(params, dem, pts, delta: float = 1.0) -> float:
    """Pseudo-Huber on height residuals: smooth everywhere, robust to outliers,
    and still informative when every residual is metres off (unlike trimming)."""
    r, _ = residuals(params, dem, pts)
    r = r[np.isfinite(r)]
    if r.size < 0.8 * len(pts):
        return 1e9
    r = np.minimum(np.abs(r), 10.0)
    return float(np.mean(delta * delta * (np.sqrt(1 + (r / delta) ** 2) - 1)))


def stats(r: np.ndarray) -> dict:
    r = r[np.isfinite(r)]
    if not r.size:
        return {'n': 0}
    a = np.abs(r)
    return {'n': int(r.size), 'medianAbsM': round(float(np.median(a)), 3),
            'p90AbsM': round(float(np.percentile(a, 90)), 3),
            'withinHalfMetre': round(float((a <= 0.5).mean()), 3)}


def fit(dem: Dem, pts: np.ndarray, start, free_rotation: bool, search_m: float = 15.0):
    """Coarse translation search (0.5 m grid), then robust least squares.

    Translation model refines (tE, tN, dy); similarity also frees rotation
    and scale. Least squares works on the residual vector, so it has real
    gradients instead of a single trimmed number.
    """
    from scipy.optimize import least_squares
    best = None
    steps = np.arange(-search_m, search_m + 1e-9, 0.5)
    for dE in steps:
        for dN in steps:
            p = (start[0] + dE, start[1] + dN, start[2], start[3])
            c = cost(p, dem, pts)
            if best is None or c < best[0]:
                best = (c, p)
    p0 = np.array(best[1], dtype=float)
    _, dy0 = residuals(tuple(p0), dem, pts)
    xz, y = pts[:, [0, 2]], pts[:, 1]

    def vec(q):
        p = (p0[0] + q[0], p0[1] + q[1],
             p0[2] + (q[3] * 1e-3 if free_rotation else 0.0),
             p0[3] + (q[4] * 1e-4 if free_rotation else 0.0))
        r = dem.sample(apply(p, xz)) - y - (dy0 + q[2])
        return np.where(np.isfinite(r), r, 10.0)

    q0 = np.zeros(5 if free_rotation else 3)
    res = least_squares(vec, q0, loss='soft_l1', f_scale=0.5, diff_step=1e-3)
    q = res.x
    return (p0[0] + q[0], p0[1] + q[1],
            p0[2] + (q[3] * 1e-3 if free_rotation else 0.0),
            p0[3] + (q[4] * 1e-4 if free_rotation else 0.0))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--gkd', required=True, type=Path)
    ap.add_argument('--dem', required=True, type=Path, help='dem-utm16n-1m.json')
    ap.add_argument('--course', required=True, type=Path, help='public course-v1.json (OSM green centroids)')
    ap.add_argument('--shots', type=Path, help='optional JSON list of {x,y,z} ball positions on the ground')
    ap.add_argument('--out', type=Path)
    args = ap.parse_args()

    raw, sha = gkd.load_raw(args.gkd)
    course = gkd.normalize(raw, sha)
    pkg = json.loads(args.course.read_text())
    gc_xz, gc_en = [], []
    for h in course['holes']:
        frame = pkg['holes'].get(str(h['hole']), {}).get('coordinateFrame', {})
        if h['greenCenter'] and frame.get('targetGreenLatLon'):
            gc_xz.append([h['greenCenter']['x'], h['greenCenter']['z']])
            gc_en.append(utm16n(*frame['targetGreenLatLon']))
    s0, th0, t0 = similarity(np.array(gc_xz), np.array(gc_en))
    start = (t0[0], t0[1], th0, s0)

    groups = {
        'pins': [p for h in course['holes'] for p in h['pins']],
        'greenCentres': [h['greenCenter'] for h in course['holes'] if h['greenCenter']],
        'penaltyVertices': [q for pa in course['penaltyAreas'] for q in pa['points']],
        'oobVertices': course['outOfBounds'],
        'teeMarkers': [t for h in course['holes'] for t in h['tees'].values()],
        'aimPoints': [p for h in course['holes'] for p in h['aimPoints']],
    }
    if args.shots:
        groups['loggedShots'] = json.loads(args.shots.read_text())
    arr = {k: np.array([[p['x'], p['y'], p['z']] for p in v]) for k, v in groups.items() if v}
    fit_groups = [k for k in ('pins', 'greenCentres', 'penaltyVertices', 'oobVertices', 'loggedShots') if k in arr]
    fit_pts = np.vstack([arr[k] for k in fit_groups])

    dem = Dem(args.dem)
    report = {'schemaVersion': 'looper-course-registration-v1', 'layoutFingerprint': course['layoutFingerprint'],
              'targetCrs': 'EPSG:26916', 'fitGroups': fit_groups,
              'centroidStart': {'tE': start[0], 'tN': start[1], 'rotationDeg': math.degrees(th0), 'scale': s0}}
    r0, dy0 = residuals(start, dem, fit_pts)
    report['centroidStartResiduals'] = {**stats(r0), 'dy': round(dy0, 3)}

    # FarmLinks showed GSPro x/z are TRUE-NORTH ground metres: the free fit's
    # rotation equalled the UTM grid convergence (0.317 deg) to 0.001 deg. So
    # the default model fixes rotation and scale from map geometry and fits
    # only position + height; the free similarity fit is the cross-check.
    lats = [lat for lat, _ in (pkg['holes'][k]['coordinateFrame']['targetGreenLatLon']
                               for k in pkg['holes'] if pkg['holes'][k].get('coordinateFrame'))]
    lons = [lon for _, lon in (pkg['holes'][k]['coordinateFrame']['targetGreenLatLon']
                               for k in pkg['holes'] if pkg['holes'][k].get('coordinateFrame'))]
    gamma, k_scale = utm_convergence_scale(sum(lats) / len(lats), sum(lons) / len(lons))
    report['trueNorthFrame'] = {'gridConvergenceDeg': round(math.degrees(gamma), 5),
                                'pointScale': round(k_scale, 7)}
    true_north_start = (start[0], start[1], gamma, k_scale)

    models = {}
    for name, free, st in (('true-north', False, true_north_start), ('similarity', True, start)):
        p = fit(dem, fit_pts, st, free)
        r, dy = residuals(p, dem, fit_pts)
        # Per group, measured against the FIT's vertical offset, so a group that
        # floats above ground (tee markers ~1 m) shows up as a bias.
        per_group = {}
        for k, v in arr.items():
            g_r = dem.sample(apply(p, v[:, [0, 2]])) - v[:, 1] - dy
            per_group[k] = {**stats(g_r), 'medianSignedM': round(float(np.nanmedian(g_r)), 3)}
        models[name] = {'tE': round(p[0], 3), 'tN': round(p[1], 3),
                        'rotationDeg': round(math.degrees(p[2]), 4), 'scale': round(p[3], 6),
                        'dy': round(dy, 3), 'shiftFromCentroidStartM': round(math.hypot(p[0] - start[0], p[1] - start[1]), 2),
                        'fitResiduals': stats(r), 'byGroup': per_group, '_p': p}
    # Prefer the physically constrained model unless the free one fits clearly
    # better (which would mean this course does not use a true-north frame).
    t_med = models['true-north']['fitResiduals'].get('medianAbsM', 99)
    s_med = models['similarity']['fitResiduals'].get('medianAbsM', 99)
    chosen = 'similarity' if s_med < t_med - 0.05 else 'true-north'
    free = chosen == 'similarity'
    start = true_north_start if chosen == 'true-north' else start
    tn, sim = models['true-north'], models['similarity']
    report['freeFitRotationMinusConvergenceDeg'] = round(sim['rotationDeg'] - math.degrees(gamma), 4)
    report['modelsAgreeAtCentreM'] = round(math.hypot(tn['tE'] - sim['tE'], tn['tN'] - sim['tN']), 3)

    # Held-out halves: fit on west points, score on east, and vice versa.
    # Also compare where each half's transform puts the course centre.
    med_x = np.median(fit_pts[:, 0])
    west, east = fit_pts[fit_pts[:, 0] < med_x], fit_pts[fit_pts[:, 0] >= med_x]
    centre = np.array([[float(np.median(fit_pts[:, 0])), float(np.median(fit_pts[:, 2]))]])
    holdout, centres = {}, {}
    for train_name, train, test in (('west', west, east), ('east', east, west)):
        p = fit(dem, train, start, free, search_m=8.0)
        centres[train_name] = apply(p, centre)[0]
        r_test, _ = residuals(p, dem, test)
        holdout[f'fitOn{train_name.title()}ScoreOther'] = stats(r_test)
    split = float(np.hypot(*(centres['west'] - centres['east'])))
    med = models[chosen]['fitResiduals'].get('medianAbsM', 99)
    worst_holdout = max(h.get('medianAbsM', 99) for h in holdout.values())
    grade = ('A' if med <= 0.5 and worst_holdout <= 0.75 and split <= 1.0
             else 'B' if med <= 2.0 and worst_holdout <= 2.5 else 'C')
    for m in models.values():
        m.pop('_p')
    report.update({'models': models, 'chosenModel': chosen, 'heldOutHalves': holdout,
                   'splitHalfCentreDifferenceM': round(split, 3), 'grade': grade})
    text = json.dumps(report, indent=2)
    if args.out:
        args.out.write_text(text + '\n')
    print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
