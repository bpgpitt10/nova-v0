#!/usr/bin/env python3
"""Shrink an existing course package: clip every surface and context polygon to
its hole's view box (+ margin), the way build_enriched_package now does when it
builds one. For packages published before 5 Nov 2026 (Arcadia Bluffs carried
Lake Michigan whole on all 18 holes: 30 MB).

  python shrink_package.py public/course-geometry/arcadia-bluffs/course-v1-lidar.json [--write]
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_enriched_package import MARGIN_YDS, clip_to_box, in_box, ring_ok  # noqa: E402


def shrink(pkg: dict) -> tuple[dict, dict]:
    report = {}
    for key, hole in pkg['holes'].items():
        v = hole.get('viewBounds')
        if not v:
            continue
        box = (v['minX'] - MARGIN_YDS, v['minY'] - MARGIN_YDS, v['maxX'] + MARGIN_YDS, v['maxY'] + MARGIN_YDS)
        before = after = 0
        for group in ('surfaces', 'context'):
            layers = hole.get(group) or {}
            for kind, polys in list(layers.items()):
                if not polys or not isinstance(polys[0], list) or not polys[0] or not isinstance(polys[0][0], list):
                    continue
                before += sum(len(p) for p in polys)
                kept = []
                for ring in polys:
                    if not in_box(ring, box):
                        continue
                    c = clip_to_box(ring, box) if len(ring) > 64 else ring
                    if ring_ok(c):
                        kept.append(c)
                after += sum(len(p) for p in kept)
                layers[kind] = kept
        report[key] = f'{before}->{after}'
    return pkg, report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('package', type=Path)
    ap.add_argument('--write', action='store_true', help='overwrite the package (default: report only)')
    args = ap.parse_args()
    pkg = json.loads(args.package.read_text())
    original = args.package.stat().st_size
    pkg, report = shrink(pkg)
    text = json.dumps(pkg, separators=(',', ':')) + '\n'
    print(json.dumps({'package': str(args.package), 'originalBytes': original, 'bytes': len(text), 'points': report}, indent=1))
    if args.write:
        args.package.write_text(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
