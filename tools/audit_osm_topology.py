#!/usr/bin/env python3
"""Audit OSM multipolygon topology used by Looper course packages.

The current package schema stores simple polygon rings. This audit makes
multipolygon inner rings explicit so a course cannot silently look 'ready'
while relying on topology the runtime does not yet preserve.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

import build_osm_course_package as base


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--osm", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def useful_tags(tags: dict[str, Any]) -> dict[str, Any]:
    keys = ("type", "golf", "natural", "landuse", "water", "waterway", "name")
    return {key: tags[key] for key in keys if key in tags}


def classification(tags: dict[str, Any]) -> str | None:
    result = base.classify_element(tags)
    return f"{result[0]}:{result[1]}" if result else None


def main() -> int:
    args = parse_args()
    payload = json.loads(args.osm.read_text(encoding="utf-8"))
    elements = payload.get("elements") or []
    ways_by_id = {
        element.get("id"): element
        for element in elements
        if element.get("type") == "way" and element.get("id") is not None
    }

    relations: list[dict[str, Any]] = []
    parent_kinds: Counter[str] = Counter()
    inner_tagged = 0
    inner_untagged = 0
    inner_total = 0

    for element in elements:
        tags = element.get("tags") or {}
        if element.get("type") != "relation" or tags.get("type") != "multipolygon":
            continue
        members = element.get("members") or []
        inner_members = [member for member in members if member.get("role") == "inner"]
        if not inner_members:
            continue

        parent_class = classification(tags) or "unclassified"
        parent_kinds[parent_class] += len(inner_members)
        inner_rows: list[dict[str, Any]] = []
        for member in inner_members:
            inner_total += 1
            source_way = ways_by_id.get(member.get("ref"))
            source_tags = (source_way or {}).get("tags") or {}
            if source_tags:
                inner_tagged += 1
            else:
                inner_untagged += 1
            inner_rows.append(
                {
                    "ref": member.get("ref"),
                    "memberType": member.get("type"),
                    "tags": useful_tags(source_tags),
                    "classification": classification(source_tags),
                }
            )

        relations.append(
            {
                "relationId": element.get("id"),
                "tags": useful_tags(tags),
                "classification": classification(tags),
                "outerMembers": sum(1 for member in members if member.get("role") in ("outer", "")),
                "innerMembers": len(inner_members),
                "inners": inner_rows,
            }
        )

    report = {
        "schemaVersion": "looper-osm-topology-audit-v1",
        "multipolygonRelationsWithInnerRings": len(relations),
        "innerRingCount": inner_total,
        "innerRingsWithStandaloneTags": inner_tagged,
        "innerRingsWithoutStandaloneTags": inner_untagged,
        "innerRingsByParentClassification": dict(sorted(parent_kinds.items())),
        "relations": relations,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "relations"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
