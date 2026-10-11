#!/usr/bin/env python3
"""Fail-closed geometry gate: WorldCover must not paint over mapped tees.

Validated separately from ordinary course contract so an H13-style woods
overlap cannot slip through solely because 18 holes load successfully.
"""
import argparse
import json
from pathlib import Path

from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.validation import make_valid


def geometries(value):
    output = []
    for coords in value if isinstance(value, list) else []:
        if not isinstance(coords, list) or len(coords) < 3:
            continue
        try:
            geometry = make_valid(Polygon([(float(x), float(y)) for x, y in coords]))
        except (ValueError, TypeError):
            continue
        if not geometry.is_empty:
            output.append(geometry)
    return output


def audit_package(payload: dict, max_overlap_sqyd: float = 0.25):
    failures = []
    summary = []
    for key, hole in sorted((payload.get("holes") or {}).items(), key=lambda item: int(item[0])):
        tee = unary_union(geometries((hole.get("surfaces") or {}).get("tee") or []))
        context = hole.get("context") or {}
        for kind in ("landcover-woods", "landcover-scrub", "landcover-grass", "landcover-bare"):
            polys = geometries(context.get(kind) or [])
            if tee.is_empty or not polys:
                continue
            overlap = float(tee.intersection(unary_union(polys)).area)
            summary.append({"hole": int(key), "layer": kind, "teeOverlapSqYd": round(overlap, 3)})
            if overlap > max_overlap_sqyd:
                failures.append(f"H{key} {kind}: {overlap:.2f} sq yd overlaps mapped tee")
    return {"passed": not failures, "failures": failures, "teeOverlap": summary}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--max-overlap-sqyd", type=float, default=0.25)
    args = parser.parse_args()
    audit = audit_package(json.loads(args.package.read_text(encoding="utf-8")), args.max_overlap_sqyd)
    print(json.dumps(audit, indent=2))
    if not audit["passed"]:
        raise SystemExit("Landcover geometry audit failed: " + "; ".join(audit["failures"]))


if __name__ == "__main__":
    main()
