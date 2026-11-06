#!/usr/bin/env python3
"""Acceptance gate for a built course package: is this file fit to publish?

Run by load_course as the last stage of every load (publishing refuses on a
hard failure), by CI over every committed package, and by hand:

  python validate_package.py public/course-geometry/<slug>/course-v1-lidar.json [more...]
  python validate_package.py --json ...       machine-readable report

Hard limits (publish refuses):
  size            <= 4 MB hole package, <= 6 MB area package
  polygons        no surface ring over 2,000 points (context 8,000); every ring
                  >= 3 points; all finite
  reach           no polygon more than 2,000 yd outside the hole's view bounds
                  (soft above 500 yd)
  holes           18 holes (or 9 when the package says so), numbered 1..N
  per hole        a frame with a finite anchor and heading; view bounds finite
                  and at most 1,500 x 1,500 yd; a green polygon; a tee; terrain
                  covering >= 60% of the view bounds with no NaN
  area package    >= 18 greens, each inside the outline box (+600 m), terrain
                  valid >= 50%
Soft (recorded, publish continues):
  no fairway on a hole; no woods when LiDAR trees were expected; > 20 bunkers
  on a hole; unmapped share > 60% of a 90-yd corridor; provenance missing.

Why: Arcadia Bluffs shipped with Lake Michigan (79,625 points) in all 18
holes and a 30 MB file; nothing in the pipeline looked at the output (11/5).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import struct
import sys
import zlib
from pathlib import Path

HOLE_PACKAGE_MAX_BYTES = 4 * 1024 * 1024
AREA_PACKAGE_MAX_BYTES = 6 * 1024 * 1024
RING_MAX_POINTS = 2000          # surfaces (the engine classifies landings against these)
CONTEXT_RING_MAX_POINTS = 8000  # context layers (LiDAR woods are detailed); soft above RING_MAX_POINTS
REACH_BEYOND_VIEW_YDS = 500.0   # soft above this …
REACH_HARD_YDS = 2000.0         # … hard above this: not hole-scale geometry
VIEW_MAX_SIDE_YDS = 1500.0
TERRAIN_MIN_VALID = 0.60
AREA_TERRAIN_MIN_VALID = 0.50
AREA_MIN_GREENS = 18
BUNKERS_SOFT_MAX = 60


class Report:
    def __init__(self, path: Path):
        self.path = path
        self.hard: list[str] = []
        self.soft: list[str] = []
        self.facts: dict = {}

    def fail(self, msg: str) -> None:
        self.hard.append(msg)

    def warn(self, msg: str) -> None:
        self.soft.append(msg)

    @property
    def ok(self) -> bool:
        return not self.hard

    def as_dict(self) -> dict:
        return {'package': str(self.path), 'ok': self.ok, 'hard': self.hard, 'soft': self.soft, **self.facts}


def finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def ring_points(ring) -> list:
    return ring if isinstance(ring, list) and ring and isinstance(ring[0], list) else []


def iter_rings(polys):
    """Surface entries are either rings ([[x,y],...]) or {polygons:[ring,...]}."""
    for item in polys or []:
        if isinstance(item, dict):
            for ring in item.get('polygons') or []:
                yield ring
        else:
            yield item


def check_rings(rep: Report, where: str, polys, view, counts: dict, max_points: int = RING_MAX_POINTS) -> None:
    for ring in iter_rings(polys):
        pts = ring_points(ring)
        if len(pts) < 3:
            rep.fail(f'{where}: ring with {len(pts)} points')
            continue
        if len(pts) > max_points:
            rep.fail(f'{where}: ring with {len(pts)} points (max {max_points}); clip or simplify it')
        elif len(pts) > RING_MAX_POINTS:
            rep.warn(f'{where}: ring with {len(pts)} points; worth simplifying')
        counts['points'] += len(pts)
        xs, ys = [], []
        for p in pts:
            if not (isinstance(p, list) and len(p) >= 2 and finite(p[0]) and finite(p[1])):
                rep.fail(f'{where}: non-finite vertex {p!r}')
                break
            xs.append(p[0]); ys.append(p[1])
        if view and xs:
            over = max(view['minX'] - min(xs), max(xs) - view['maxX'], view['minY'] - min(ys), max(ys) - view['maxY'])
            if over > REACH_HARD_YDS:
                rep.fail(f'{where}: polygon reaches {over:.0f} yd outside the view bounds (max {REACH_HARD_YDS:.0f}); clip it to the hole')
            elif over > REACH_BEYOND_VIEW_YDS:
                rep.warn(f'{where}: polygon reaches {over:.0f} yd outside the view bounds')


def terrain_valid_share(terrain: dict) -> float | None:
    """Share of grid cells that carry a height (not nodata / NaN)."""
    if not isinstance(terrain, dict):
        return None
    b64 = terrain.get('valuesBase64')
    if not b64:
        values = terrain.get('values') or terrain.get('heightsFt')
        if not isinstance(values, list) or not values:
            return None
        good = sum(1 for v in values if finite(v))
        return good / len(values)
    raw = base64.b64decode(b64)
    if terrain.get('compression') == 'deflate':
        raw = zlib.decompress(raw)
    n = len(raw) // 2
    if n == 0:
        return 0.0
    nodata = terrain.get('nodata', 65535)
    vals = struct.unpack(f'<{n}H', raw[: n * 2])
    return sum(1 for v in vals if v != nodata) / n


def check_hole(rep: Report, key: str, hole: dict, expect_lidar_trees: bool) -> None:
    where = f'hole {key}'
    frame = hole.get('coordinateFrame') or {}
    anchor = frame.get('anchorLatLon')
    if not (isinstance(anchor, list) and len(anchor) == 2 and finite(anchor[0]) and finite(anchor[1])
            and abs(anchor[0]) <= 90 and abs(anchor[1]) <= 180):
        rep.fail(f'{where}: frame anchor missing or not a lat/lon')
    if not finite(frame.get('headingDegreesTrue')):
        rep.fail(f'{where}: frame heading missing')
    view = hole.get('viewBounds')
    if not (isinstance(view, dict) and all(finite(view.get(k)) for k in ('minX', 'maxX', 'minY', 'maxY'))):
        rep.fail(f'{where}: view bounds missing')
        view = None
    elif view['maxX'] - view['minX'] > VIEW_MAX_SIDE_YDS or view['maxY'] - view['minY'] > VIEW_MAX_SIDE_YDS:
        rep.fail(f'{where}: view bounds {view["maxX"] - view["minX"]:.0f} x {view["maxY"] - view["minY"]:.0f} yd (max {VIEW_MAX_SIDE_YDS:.0f})')
    surfaces = hole.get('surfaces') or {}
    counts = {'points': 0}
    for kind, polys in surfaces.items():
        check_rings(rep, f'{where} {kind}', polys, view, counts)
    for kind, polys in (hole.get('context') or {}).items():
        check_rings(rep, f'{where} context {kind}', polys, view, counts, CONTEXT_RING_MAX_POINTS)
    if not list(iter_rings(surfaces.get('green'))):
        rep.fail(f'{where}: no green polygon')
    if not list(iter_rings(surfaces.get('tee'))) and not hole.get('teeCandidates'):
        rep.fail(f'{where}: no tee')
    if not list(iter_rings(surfaces.get('fairway'))) and (hole.get('par') or 4) > 3:
        rep.warn(f'{where}: no fairway polygon on a par {hole.get("par") or "4+"}')
    bunkers = len(list(iter_rings(surfaces.get('bunker'))))
    if bunkers > BUNKERS_SOFT_MAX:
        rep.warn(f'{where}: {bunkers} bunker polygons')
    if expect_lidar_trees and not list(iter_rings((hole.get('context') or {}).get('woods'))):
        rep.warn(f'{where}: LiDAR trees expected but no woods layer')
    share = terrain_valid_share(hole.get('terrain'))
    if share is None:
        rep.fail(f'{where}: no terrain grid')
    elif share < TERRAIN_MIN_VALID:
        rep.fail(f'{where}: terrain covers {share:.0%} of the hole (min {TERRAIN_MIN_VALID:.0%})')
    rep.facts.setdefault('holes', {})[key] = {'points': counts['points'], 'terrainValid': None if share is None else round(share, 3)}


def validate_hole_package(rep: Report, pkg: dict) -> None:
    holes = pkg.get('holes')
    if not isinstance(holes, dict) or not holes:
        rep.fail('no holes')
        return
    keys = sorted(int(k) for k in holes if str(k).isdigit())
    expected = 9 if pkg.get('holeCount') == 9 else 18
    if keys != list(range(1, expected + 1)):
        rep.fail(f'holes are {keys}, expected 1..{expected}')
    enrichment = pkg.get('enrichment') or {}
    expect_lidar_trees = enrichment.get('trees', 'lidar' if enrichment else None) == 'lidar'
    for key in holes:
        check_hole(rep, str(key), holes[key], expect_lidar_trees)
    for field in ('courseId', 'courseName', 'schemaVersion'):
        if not pkg.get(field):
            rep.fail(f'missing {field}')
    if not pkg.get('provenance') and not pkg.get('terrainProvenance'):
        rep.warn('no provenance block')


def validate_area_package(rep: Report, pkg: dict) -> None:
    area = pkg.get('area') or {}
    greens = area.get('greens') or []
    if len(greens) < AREA_MIN_GREENS:
        rep.fail(f'area has {len(greens)} greens (min {AREA_MIN_GREENS})')
    box = area.get('bounds') or area.get('viewBounds')
    counts = {'points': 0}
    for kind, polys in (area.get('surfaces') or {}).items():
        check_rings(rep, f'area {kind}', polys, None, counts)
    for layer in area.get('contextLayers') or []:
        check_rings(rep, f"area context {layer.get('kind')}", layer.get('polygons'), None, counts, CONTEXT_RING_MAX_POINTS)
    if isinstance(box, dict) and all(finite(box.get(k)) for k in ('minX', 'maxX', 'minY', 'maxY')):
        pad = 656.0  # 600 m
        for i, g in enumerate(greens):
            c = g.get('center') or g.get('centroid') or g
            x, y = (c[0], c[1]) if isinstance(c, list) else (c.get('x'), c.get('y'))
            if not (finite(x) and finite(y)) or x < box['minX'] - pad or x > box['maxX'] + pad or y < box['minY'] - pad or y > box['maxY'] + pad:
                rep.fail(f'green {i + 1} outside the area box')
    share = terrain_valid_share(area.get('terrain') or pkg.get('terrain'))
    if share is None:
        rep.fail('no terrain grid')
    elif share < AREA_TERRAIN_MIN_VALID:
        rep.fail(f'terrain covers {share:.0%} of the area (min {AREA_TERRAIN_MIN_VALID:.0%})')
    rep.facts['greens'] = len(greens)
    rep.facts['points'] = counts['points']
    for field in ('courseId', 'courseName'):
        if not pkg.get(field):
            rep.fail(f'missing {field}')


def validate_file(path: Path) -> Report:
    rep = Report(path)
    data = path.read_bytes()
    rep.facts['bytes'] = len(data)
    rep.facts['sha256'] = hashlib.sha256(data).hexdigest()
    try:
        pkg = json.loads(data)
    except ValueError as exc:
        rep.fail(f'not JSON: {exc}')
        return rep
    is_area = 'area' in pkg and 'holes' not in pkg
    limit = AREA_PACKAGE_MAX_BYTES if is_area else HOLE_PACKAGE_MAX_BYTES
    if len(data) > limit:
        rep.fail(f'{len(data) / 1e6:.1f} MB (max {limit / 1e6:.0f} MB)')
    if is_area:
        validate_area_package(rep, pkg)
    else:
        validate_hole_package(rep, pkg)
    return rep


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('packages', nargs='+', type=Path)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--report', type=Path, help='write the JSON report here as well')
    args = ap.parse_args()
    reports = [validate_file(p) for p in args.packages]
    if args.report:
        args.report.write_text(json.dumps([r.as_dict() for r in reports], indent=1) + '\n')
    if args.json:
        print(json.dumps([r.as_dict() for r in reports], indent=1))
    else:
        for r in reports:
            print(f"{'OK  ' if r.ok else 'FAIL'} {r.path} ({r.facts.get('bytes', 0) / 1e6:.1f} MB)")
            for m in r.hard:
                print(f'   hard: {m}')
            for m in r.soft:
                print(f'   soft: {m}')
    return 0 if all(r.ok for r in reports) else 1


if __name__ == '__main__':
    sys.exit(main())
