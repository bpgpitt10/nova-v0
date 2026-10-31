#!/usr/bin/env python3
"""GSPro GKD / GKDalt -> normalized native course contract (standard library only).

Facts this relies on, verified against the FarmLinks GKD and real GSPro output:
- Positions are GSPro world metres: x east, z north, y up.
- Tee `Distance` = metres along tee -> AimPoint1 -> AimPoint2 -> GreenCenterPoint
  (125 of 126 FarmLinks tee entries within 0.5 m).
- GSPro's tee-box HUD distance = the same aim route ending at the active pin
  (FarmLinks H1 White -> pin slot 1: 492.62 yd vs HUD 492.6).
- currentRound `DistanceToPin` = straight 2D line from EndingPOS to the active
  pin (Round 255: 449.56 yd, exact to 0.01 yd).
- A shot's StartingPOS x/z equals the GKD tee x/z for the tee played.
- Pin entries carry weekday labels, but GSPro does NOT pick them by weekday
  (a Tuesday round used the "Thursday" entry). They are treated as slots.
- `Hazards` are penalty areas (drop-zone / free-drop / innerOOB flags), not
  bunkers. Fairway, rough, bunkers and trees are not in the GKD.

The raw GKD is third-party content: read it on the player's machine; never
commit or redistribute it. Only derived outputs leave this module.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any

CONTRACT = 'looper-gspro-native-course-v1'
PARSER_VERSION = '0.1.0'
METERS_TO_YARDS = 1.0936132983377078
PLAYABLE_TEES = ('Black', 'Blue', 'White', 'Green', 'Yellow', 'Red', 'Junior', 'Par3')
MAX_BYTES = 8 * 1024 * 1024


class GkdError(ValueError):
    pass


def _xyz(p: Any) -> dict[str, float] | None:
    if not isinstance(p, dict):
        return None
    try:
        x, y, z = float(p['x']), float(p['y']), float(p['z'])
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, z)):
        return None
    return {'x': x, 'y': y, 'z': z}


def _d2(a: dict, b: dict) -> float:
    return math.hypot(a['x'] - b['x'], a['z'] - b['z'])


def load_raw(path: Path) -> tuple[dict, str]:
    data = Path(path).read_bytes()
    if len(data) > MAX_BYTES:
        raise GkdError(f'GKD larger than {MAX_BYTES} bytes')
    try:
        raw = json.loads(data.decode('utf-8-sig'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GkdError(f'not a JSON GKD: {exc}') from exc
    if not isinstance(raw, dict) or not isinstance(raw.get('Holes'), list):
        raise GkdError('missing Holes array')
    return raw, hashlib.sha256(data).hexdigest()


def route_distance_m(start: dict, aim_points: list[dict], target: dict) -> float:
    """Aim-route length, skipping aim points that are not ahead of the start.

    Forward tees (Junior, Par3) often sit past AimPoint1; GSPro's routed
    distance then starts at the first aim point nearer the target than the tee.
    """
    to_target = _d2(start, target)
    ahead = [p for p in aim_points if _d2(p, target) < to_target]
    pts = [start, *ahead, target]
    return sum(_d2(a, b) for a, b in zip(pts, pts[1:]))


def normalize(raw: dict, source_sha256: str | None = None) -> dict:
    holes = []
    for h in raw['Holes']:
        if not isinstance(h, dict):
            raise GkdError('hole entry is not an object')
        tees, aims, green_center = {}, {}, None
        for t in h.get('Tees') or []:
            kind = t.get('TeeType')
            pos = _xyz(t.get('Position'))
            if pos is None:
                continue
            if kind in ('AimPoint1', 'AimPoint2'):
                aims[kind] = pos
            elif kind == 'GreenCenterPoint':
                green_center = pos
            elif kind:
                tees[kind] = {**pos, 'distanceM': float(t.get('Distance') or 0.0),
                              'enabled': bool(t.get('Enabled', True))}
        pins = []
        for slot, p in enumerate(h.get('Pins') or [], start=1):
            pos = _xyz(p.get('Position'))
            if pos is not None:
                pins.append({'slot': slot, 'label': p.get('Day'), **pos})
        holes.append({
            'hole': int(h.get('HoleNumber')),
            'par': h.get('Par'),
            'strokeIndex': h.get('Index'),
            'tees': tees,
            'aimPoints': [aims[k] for k in ('AimPoint1', 'AimPoint2') if k in aims],
            'greenCenter': green_center,
            'pins': pins,
        })
    holes.sort(key=lambda r: r['hole'])

    penalty = []
    for i, hz in enumerate(raw.get('Hazards') or []):
        pts = [q for q in (_xyz(c) for c in hz.get('coords') or []) if q]
        if len(pts) < 3:
            continue
        ys = [q['y'] for q in pts]
        sd = statistics.pstdev(ys)
        penalty.append({
            'id': i, 'points': pts,
            'freeDrop': bool(hz.get('freeDrop')), 'innerOOB': bool(hz.get('innerOOB')),
            'islandGreen': bool(hz.get('islandGreen')), 'noAIL': bool(hz.get('noAIL')),
            'dropZone': _xyz(hz.get('DZpos')) if hz.get('hasDZ') else None,
            'edgeElevationSdM': round(sd, 3),
            # Flat edge suggests open water; steep edge suggests a dry ravine/creek.
            # A hint for review only, never a lie or penalty decision.
            'surfaceHint': 'likely-water' if sd < 0.5 else 'likely-dry-or-mixed',
        })
    oob = [q for q in (_xyz(c) for c in (raw.get('pOOB') or {}).get('coords') or []) if q]

    return {
        'contract': CONTRACT,
        'parserVersion': PARSER_VERSION,
        'sourceSha256': source_sha256,
        'layoutFingerprint': layout_fingerprint(holes),
        'sceneFingerprint': scene_fingerprint(holes),
        'identity': {
            'courseName': raw.get('CourseName'),
            'sceneFolderName': raw.get('SceneFolderName'),  # GKDalt only; equals live CourseKey
            'location': raw.get('Location'),
            'designer': raw.get('Designer'),
            'gkversion': raw.get('gkversion'),
            'hasAlternateLayouts': raw.get('HasAlternateLayouts'),
            'courseLatLon': [raw.get('CourseLat'), raw.get('CourseLong')]
            if raw.get('CourseLat') else None,
        },
        'frame': {'units': 'metres', 'axes': 'x east, z north, y up (GSPro world)'},
        'holes': holes,
        'penaltyAreas': penalty,
        'outOfBounds': oob,
    }


def _dm(v: float) -> int:
    """Round to integer decimetres, half up, identically in Python and JS."""
    return math.floor(v * 10 + 0.5)


def layout_fingerprint_text(holes: list[dict]) -> str:
    """Canonical layout text. Mirrored byte-for-byte by the web app
    (src/courseGeometry/nativeGkd.ts) so both sides hash the same thing."""
    lines = []
    for h in sorted(holes, key=lambda r: r['hole']):
        tees = ';'.join(f"{name}:{_dm(t['x'])},{_dm(t['z'])}" for name, t in sorted(h['tees'].items()))
        pins = ';'.join(f"{_dm(p['x'])},{_dm(p['z'])}" for p in h['pins'])
        gc = h['greenCenter']
        gc_txt = '-' if gc is None else f"{_dm(gc['x'])},{_dm(gc['z'])}"
        lines.append(f"{h['hole']}|{tees}|{pins}|{gc_txt}")
    return '\n'.join(lines)


def scene_fingerprint_text(holes: list[dict]) -> str:
    """Canonical scene text: pins and green centres only (no tees).

    Alternate layouts of one GSPro scene (e.g. "Farmlinks Kids.GKDalt" with
    SceneFolderName farmlinks_al_2_7_gsp) share greens and pins but move every
    tee, so the world <-> real-world registration belongs to the scene and is
    keyed by this. Mirrored by src/courseGeometry/nativeGkd.ts.
    """
    lines = []
    for h in sorted(holes, key=lambda r: r['hole']):
        pins = ';'.join(f"{_dm(p['x'])},{_dm(p['z'])}" for p in h['pins'])
        gc = h['greenCenter']
        gc_txt = '-' if gc is None else f"{_dm(gc['x'])},{_dm(gc['z'])}"
        lines.append(f"{h['hole']}|{pins}|{gc_txt}")
    return '\n'.join(lines)


def scene_fingerprint(holes: list[dict]) -> str:
    return hashlib.sha256(scene_fingerprint_text(holes).encode('utf-8')).hexdigest()


def layout_fingerprint(holes: list[dict]) -> str:
    """SHA-256 of tee, pin and green-centre positions at 0.1 m.

    Survives renamed files and metadata edits; changes when the layout moves.
    """
    return hashlib.sha256(layout_fingerprint_text(holes).encode('utf-8')).hexdigest()


def check_tee_distances(course: dict, tol_m: float = 0.5) -> dict:
    checked, mismatches = 0, []
    by_method = {'route': 0, 'straight': 0}
    for h in course['holes']:
        gc = h['greenCenter']
        if gc is None:
            continue
        for name, t in h['tees'].items():
            if name not in PLAYABLE_TEES or t['distanceM'] <= 0:
                continue
            checked += 1
            route = route_distance_m(t, h['aimPoints'], gc)
            straight = _d2(t, gc)
            if abs(route - t['distanceM']) <= tol_m:
                by_method['route'] += 1
            elif abs(straight - t['distanceM']) <= tol_m:
                by_method['straight'] += 1  # seen on some Junior tees
            else:
                mismatches.append({'hole': h['hole'], 'tee': name, 'gkdDistanceM': t['distanceM'],
                                   'routeM': round(route, 3), 'straightM': round(straight, 3)})
    return {'checked': checked, 'matchedBy': by_method, 'mismatches': mismatches}


def hole(course: dict, number: int) -> dict:
    for h in course['holes']:
        if h['hole'] == number:
            return h
    raise GkdError(f'hole {number} not in layout')


def resolve_tee(course: dict, hole_number: int, starting_pos: dict,
                tol_m: float = 5.0, ambiguity_m: float = 3.0) -> dict:
    """Which GKD tee a shot started from. Several named tees can share a spot;
    distances depend only on position, so ambiguity is reported, not fatal."""
    h = hole(course, hole_number)
    ranked = sorted(((round(_d2(t, starting_pos), 3), name) for name, t in h['tees'].items()
                     if name in PLAYABLE_TEES))
    if not ranked or ranked[0][0] > tol_m:
        return {'status': 'no-match', 'nearest': ranked[:2]}
    best = ranked[0][0]
    tied = [name for d, name in ranked if d - best <= ambiguity_m and d <= tol_m]
    return {'status': 'matched' if len(tied) == 1 else 'ambiguous-same-spot',
            'tee': ranked[0][1], 'candidates': tied, 'offsetM': best}


def resolve_pin(course: dict, hole_number: int, ending_pos: dict, distance_to_pin_m: float,
                tol_m: float = 0.5) -> dict:
    """Which pin slot GSPro used, from one completed shot's DistanceToPin."""
    h = hole(course, hole_number)
    ranked = sorted((abs(_d2(p, ending_pos) - distance_to_pin_m), p['slot'], p.get('label'))
                    for p in h['pins'])
    if not ranked or ranked[0][0] > tol_m:
        return {'status': 'no-match', 'nearestErrorM': ranked[0][0] if ranked else None}
    if len(ranked) > 1 and ranked[1][0] <= tol_m:
        return {'status': 'ambiguous', 'slots': [r[1] for r in ranked if r[0] <= tol_m]}
    return {'status': 'matched', 'slot': ranked[0][1], 'label': ranked[0][2],
            'errorM': round(ranked[0][0], 3)}


def tee_hud_yards(course: dict, hole_number: int, tee: str, pin_slot: int) -> float:
    """Distance GSPro shows on the tee box: aim route to the active pin."""
    h = hole(course, hole_number)
    pin = next(p for p in h['pins'] if p['slot'] == pin_slot)
    return route_distance_m(h['tees'][tee], h['aimPoints'], pin) * METERS_TO_YARDS


def straight_yards(a: dict, b: dict) -> float:
    return _d2(a, b) * METERS_TO_YARDS


def summary(course: dict) -> dict:
    return {
        'contract': course['contract'],
        'layoutFingerprint': course['layoutFingerprint'],
        'sourceSha256': course['sourceSha256'],
        'identity': course['identity'],
        'holes': len(course['holes']),
        'teeEntries': sum(len(h['tees']) for h in course['holes']),
        'pins': sum(len(h['pins']) for h in course['holes']),
        'holesWithAimPoint2': sum(1 for h in course['holes'] if len(h['aimPoints']) == 2),
        'penaltyAreas': len(course['penaltyAreas']),
        'outOfBoundsVertices': len(course['outOfBounds']),
        'teeDistanceCheck': check_tee_distances(course),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('gkd', type=Path)
    ap.add_argument('--out', type=Path, help='write the normalized contract here (keep out of git)')
    args = ap.parse_args()
    raw, sha = load_raw(args.gkd)
    course = normalize(raw, sha)
    if args.out:
        args.out.write_text(json.dumps(course, indent=1) + '\n')
    print(json.dumps(summary(course), indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
