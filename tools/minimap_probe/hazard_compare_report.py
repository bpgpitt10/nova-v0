#!/usr/bin/env python3
"""Step 10: compare Looper hazard sources against each other and physical shot truth.

Consumes HazardGeometry v0 bundles from Step 8/9, compares only geometry that is
actually in a shared coordinate space, bridges world-comparable HazardGeometry
directly into the existing physical-shot truth rules, and writes a human-readable
report plus machine-readable scorecards.

This is evidence tooling only. It never promotes a source or grants strategy
authority.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

import hazard_geometry_contract as hg
import hazard_world_truth as hwt

SCHEMA_VERSION = "looper-hazard-comparison-v0"
STRATEGY_AUTHORITY = False
PAIRWISE_SPACE_PRIORITY = (
    "gspro_world_xz",
    "hole_local_yards",
    "minimap_normalized",
    "minimap_pixel",
)
GEOMETRY_TYPE_PRIORITY = {
    "polygon": 0,
    "bbox": 1,
    "polyline": 2,
    "point_set": 3,
    "mask_ref": 4,
}
CLASS_TO_TRUTH_SEMANTICS = {
    "bunker": ["bunker"],
    "water": ["water"],
    "penalty_area": ["penalty_area"],
    "out_of_bounds": ["out_of_bounds"],
    "generic_hazard": ["hazard_unspecified"],
    "uncertain": ["hazard_unspecified"],
}


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    temp.replace(path)


def _finite(value: Any) -> float | None:
    try:
        out = float(value)
    except Exception:
        return None
    return out if math.isfinite(out) else None


def _median(values: Iterable[Any]) -> float | None:
    rows = sorted(v for v in (_finite(x) for x in values) if v is not None)
    if not rows:
        return None
    middle = len(rows) // 2
    return rows[middle] if len(rows) % 2 else (rows[middle - 1] + rows[middle]) / 2.0


def _fmt_rate(value: Any) -> str:
    number = _finite(value)
    return "—" if number is None else f"{number:.0%}"


def load_bundle(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    payload = _read(path)
    if not isinstance(payload, dict) or payload.get("schema_version") != hg.BUNDLE_SCHEMA_VERSION:
        raise ValueError(f"{path} is not a HazardGeometry bundle")
    if payload.get("strategy_authority") is not False:
        raise ValueError(f"{path} unexpectedly grants strategy authority")
    objects: list[dict[str, Any]] = []
    errors = list(payload.get("adapter_errors") or [])
    for index, row in enumerate(payload.get("objects") or []):
        try:
            objects.append(hg.validate_geometry(dict(row)))
        except Exception as exc:
            errors.append({"artifact": str(path), "index": index, "error": f"{type(exc).__name__}: {exc}"})
    return objects, errors


def collect_bundle_paths(explicit: list[str], capture_roots: list[str], output_root: Path) -> list[Path]:
    paths: list[Path] = []
    for raw in explicit:
        p = Path(raw).expanduser()
        if p.is_file():
            paths.append(p)
        elif p.is_dir():
            paths += sorted(p.rglob("hazard_geometry_v0.json"))
    for raw in capture_roots:
        root = Path(raw).expanduser()
        if root.is_dir():
            paths += sorted(root.rglob("hazard_geometry_v0.json"))
    if not paths and output_root.is_dir():
        candidates = [p for p in output_root.glob("tee_capture_*/hazard_geometry_v0.json") if p.is_file()]
        if candidates:
            newest = max(candidates, key=lambda p: p.stat().st_mtime)
            paths = [newest]
    seen: set[str] = set()
    out: list[Path] = []
    for path in paths:
        key = str(path.resolve()).lower()
        if key not in seen:
            seen.add(key)
            out.append(path.resolve())
    return out


def collect_round_paths(explicit: list[str], capture_roots: list[str], locallow: str | None) -> list[Path]:
    local = hwt.find_locallow(locallow)
    return hwt.collect_current_round_paths(explicit, capture_roots, local)


def _identity_compatible(a: dict[str, Any], b: dict[str, Any]) -> bool:
    # Missing identity is a wildcard; explicit disagreement is a hard veto.
    for key in ("course_key", "hole_display", "capture_id"):
        av, bv = a.get(key), b.get(key)
        if av is not None and bv is not None and str(av).lower() != str(bv).lower():
            return False
    return True


def _rep_bbox(rep: dict[str, Any]) -> list[float] | None:
    bbox = rep.get("bbox")
    if isinstance(bbox, list) and len(bbox) == 4:
        vals = [_finite(v) for v in bbox]
        if all(v is not None for v in vals):
            return [float(v) for v in vals]
    points = rep.get("points") or []
    xy: list[tuple[float, float]] = []
    for point in points:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            x, y = _finite(point[0]), _finite(point[1])
            if x is not None and y is not None:
                xy.append((x, y))
    if not xy:
        return None
    xs, ys = [p[0] for p in xy], [p[1] for p in xy]
    return [min(xs), min(ys), max(xs), max(ys)]


def _bbox_iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ia = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    ib = max(0.0, min(ay2, by2) - max(ay1, by1))
    intersection = ia * ib
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - intersection
    return intersection / union if union > 0 else 0.0


def _object_reps_by_space(item: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for rep in item.get("representations") or []:
        space = rep.get("coordinate_space")
        if space not in PAIRWISE_SPACE_PRIORITY:
            continue
        if _rep_bbox(rep) is None:
            continue
        existing = rows.get(space)
        if existing is None or GEOMETRY_TYPE_PRIORITY.get(rep.get("geometry_type"), 99) < GEOMETRY_TYPE_PRIORITY.get(existing.get("geometry_type"), 99):
            rows[space] = rep
    return rows


def source_inventory(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in objects:
        grouped[str((item.get("source") or {}).get("kind") or "unknown")].append(item)
    out: list[dict[str, Any]] = []
    for source, rows in sorted(grouped.items()):
        classes = Counter(str(row.get("hazard_class")) for row in rows)
        spaces = Counter(
            str(rep.get("coordinate_space"))
            for row in rows
            for rep in row.get("representations") or []
        )
        comparable = sum(
            1
            for row in rows
            if any(bool(rep.get("comparable_to_gspro_world")) for rep in row.get("representations") or [])
        )
        out.append({
            "source_kind": source,
            "object_count": len(rows),
            "class_counts": dict(classes),
            "coordinate_spaces": dict(spaces),
            "world_comparable_object_count": comparable,
            "semantic_confidence_median": _median((row.get("confidence") or {}).get("semantic") for row in rows),
            "geometry_confidence_median": _median((row.get("confidence") or {}).get("geometry") for row in rows),
            "strategy_authority": False,
        })
    return out


def _shared_space(a_rows: list[dict[str, Any]], b_rows: list[dict[str, Any]]) -> str | None:
    a_spaces = {space for row in a_rows for space in _object_reps_by_space(row)}
    b_spaces = {space for row in b_rows for space in _object_reps_by_space(row)}
    for space in PAIRWISE_SPACE_PRIORITY:
        if space in a_spaces and space in b_spaces:
            # Never pretend different captures share minimap/image coordinates.
            if space.startswith("minimap") or space == "hole_local_yards":
                compatible_pair_exists = any(
                    _identity_compatible(a.get("identity") or {}, b.get("identity") or {})
                    for a in a_rows for b in b_rows
                    if space in _object_reps_by_space(a) and space in _object_reps_by_space(b)
                )
                if not compatible_pair_exists:
                    continue
            return space
    return None


def compare_source_pair(
    source_a: str,
    a_rows: list[dict[str, Any]],
    source_b: str,
    b_rows: list[dict[str, Any]],
    *,
    iou_threshold: float,
) -> dict[str, Any]:
    space = _shared_space(a_rows, b_rows)
    class_a = Counter(str(row.get("hazard_class")) for row in a_rows)
    class_b = Counter(str(row.get("hazard_class")) for row in b_rows)
    class_keys = set(class_a) | set(class_b)
    count_intersection = sum(min(class_a[k], class_b[k]) for k in class_keys)
    count_union = sum(max(class_a[k], class_b[k]) for k in class_keys)
    base = {
        "source_a": source_a,
        "source_b": source_b,
        "class_count_agreement": count_intersection / count_union if count_union else None,
        "shared_coordinate_space": space,
        "iou_threshold": iou_threshold,
        "strategy_authority": False,
    }
    if space is None:
        return {
            **base,
            "spatial_status": "not-comparable-no-shared-trusted-space",
            "spatial_match_count": 0,
            "spatial_match_f1": None,
            "semantic_agreement_on_matches": None,
            "semantic_mismatches": [],
        }

    aa = [(row, _rep_bbox(_object_reps_by_space(row).get(space, {}))) for row in a_rows if space in _object_reps_by_space(row)]
    bb = [(row, _rep_bbox(_object_reps_by_space(row).get(space, {}))) for row in b_rows if space in _object_reps_by_space(row)]
    pairs: list[tuple[float, int, int]] = []
    for i, (a, abox) in enumerate(aa):
        if abox is None:
            continue
        for j, (b, bbox) in enumerate(bb):
            if bbox is None or not _identity_compatible(a.get("identity") or {}, b.get("identity") or {}):
                continue
            score = _bbox_iou(abox, bbox)
            if score >= iou_threshold:
                pairs.append((score, i, j))
    pairs.sort(reverse=True)
    used_a: set[int] = set()
    used_b: set[int] = set()
    matches: list[dict[str, Any]] = []
    for score, i, j in pairs:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        a, b = aa[i][0], bb[j][0]
        matches.append({
            "geometry_id_a": a.get("geometry_id"),
            "geometry_id_b": b.get("geometry_id"),
            "hazard_class_a": a.get("hazard_class"),
            "hazard_class_b": b.get("hazard_class"),
            "semantic_agreement": a.get("hazard_class") == b.get("hazard_class"),
            "bbox_iou": score,
            "identity_a": a.get("identity") or {},
            "identity_b": b.get("identity") or {},
        })
    denominator = len(aa) + len(bb)
    semantic_same = sum(1 for row in matches if row["semantic_agreement"])
    mismatches = [row for row in matches if not row["semantic_agreement"]]
    return {
        **base,
        "spatial_status": "comparable",
        "source_a_objects_in_space": len(aa),
        "source_b_objects_in_space": len(bb),
        "spatial_match_count": len(matches),
        "spatial_match_f1": (2.0 * len(matches) / denominator) if denominator else None,
        "semantic_agreement_on_matches": semantic_same / len(matches) if matches else None,
        "semantic_mismatches": mismatches,
        "matches": matches,
    }


def pairwise_comparisons(objects: list[dict[str, Any]], iou_threshold: float = 0.10) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in objects:
        grouped[str((item.get("source") or {}).get("kind") or "unknown")].append(item)
    sources = sorted(grouped)
    return [
        compare_source_pair(a, grouped[a], b, grouped[b], iou_threshold=iou_threshold)
        for i, a in enumerate(sources)
        for b in sources[i + 1:]
    ]


def _world_points(rep: dict[str, Any]) -> tuple[list[dict[str, float]], bool]:
    if rep.get("coordinate_space") != "gspro_world_xz" or not rep.get("comparable_to_gspro_world"):
        return [], False
    if rep.get("geometry_type") == "bbox" and isinstance(rep.get("bbox"), list) and len(rep["bbox"]) == 4:
        x1, z1, x2, z2 = [float(v) for v in rep["bbox"]]
        return [
            {"x": x1, "z": z1}, {"x": x2, "z": z1},
            {"x": x2, "z": z2}, {"x": x1, "z": z2},
        ], True
    points = []
    for value in rep.get("points") or []:
        if isinstance(value, (list, tuple)) and len(value) >= 2:
            x, z = _finite(value[0]), _finite(value[1])
            if x is not None and z is not None:
                points.append({"x": x, "z": z})
    return points, rep.get("geometry_type") == "polygon"


def world_truth_candidates(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in objects:
        best: tuple[list[dict[str, float]], bool, dict[str, Any]] | None = None
        for rep in item.get("representations") or []:
            points, polygon = _world_points(rep)
            if points:
                best = (points, polygon, rep)
                if polygon:
                    break
        if best is None:
            continue
        points, polygon, rep = best
        identity = item.get("identity") or {}
        cls = str(item.get("hazard_class") or "generic_hazard")
        out.append({
            "candidate_id": item.get("geometry_id"),
            # Group truth by stable source kind, not per-file path/name.
            "source": str((item.get("source") or {}).get("kind") or "unknown"),
            "source_kind": str((item.get("source") or {}).get("kind") or "unknown"),
            "semantics": CLASS_TO_TRUTH_SEMANTICS.get(cls, ["hazard_unspecified"]),
            "points_xz": points,
            "polygon_candidate": bool(polygon),
            "coordinate_space": "gspro_world_xz",
            "coordinate_space_status": str(rep.get("transform_status") or "world-comparable"),
            "comparable_to_shots": True,
            "hole_hint": identity.get("hole_display"),
            "strategy_authority": False,
        })
    return out


def load_shots(paths: list[Path]) -> tuple[list[dict[str, Any]], list[str]]:
    shots: list[dict[str, Any]] = []
    errors: list[str] = []
    for path in paths:
        try:
            for shot in hwt.load_current_round(path):
                shot["source_current_round"] = str(path)
                shots.append(shot)
        except Exception as exc:
            errors.append(f"{path}:{type(exc).__name__}:{exc}")
    return hwt.dedupe_shots(shots), errors


def truth_analysis(
    objects: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    *,
    near_tolerance: float,
) -> dict[str, Any]:
    candidates = world_truth_candidates(objects)
    validation = hwt.validate(observations, candidates, near_tolerance)
    score = hwt.scorecard(validation)
    return {
        "candidate_count": len(candidates),
        "observation_count": len(observations),
        "validation": validation,
        "source_scorecard": score,
        "strategy_authority": False,
    }


def _truth_row_map(truth: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = ((truth.get("source_scorecard") or {}).get("sources") or [])
    return {str(row.get("source")): row for row in rows}


def _evidence_state(inventory: dict[str, Any], truth_row: dict[str, Any] | None) -> str:
    spaces = set((inventory.get("coordinate_spaces") or {}).keys())
    if inventory.get("world_comparable_object_count", 0) <= 0:
        if "unknown_asset_or_serialized_space" in spaces:
            return "coordinate-transform-blocked"
        return "image-or-hole-local-only"
    if not truth_row:
        return "world-comparable-but-no-shot-truth"
    contradictions = int(truth_row.get("positive_misses", 0) or 0) + int(truth_row.get("boundary_misses", 0) or 0) + int(truth_row.get("safe_contradictions", 0) or 0)
    hits = int(truth_row.get("positive_hits", 0) or 0) + int(truth_row.get("boundary_hits", 0) or 0)
    if contradictions:
        return "contradicted-on-current-corpus"
    if hits:
        return "promising-needs-more-corpus"
    return "insufficient-positive-truth"


def combined_source_scorecard(inventory: list[dict[str, Any]], truth: dict[str, Any]) -> list[dict[str, Any]]:
    truth_map = _truth_row_map(truth)
    rows = []
    for item in inventory:
        source = item["source_kind"]
        truth_row = truth_map.get(source)
        rows.append({
            **item,
            "truth": truth_row,
            "evidence_state": _evidence_state(item, truth_row),
            "promotion_eligible": False,
            "strategy_authority": False,
        })
    return rows


def build_summary(
    objects: list[dict[str, Any]],
    adapter_errors: list[dict[str, Any]],
    inventory: list[dict[str, Any]],
    pairwise: list[dict[str, Any]],
    truth: dict[str, Any],
) -> dict[str, Any]:
    states = Counter(row.get("evidence_state") for row in combined_source_scorecard(inventory, truth))
    comparable_pairs = [row for row in pairwise if row.get("spatial_status") == "comparable"]
    return {
        "schema_version": SCHEMA_VERSION,
        "object_count": len(objects),
        "source_count": len(inventory),
        "class_counts": dict(Counter(str(row.get("hazard_class")) for row in objects)),
        "adapter_error_count": len(adapter_errors),
        "pair_count": len(pairwise),
        "spatially_comparable_pair_count": len(comparable_pairs),
        "truth_observation_count": truth.get("observation_count", 0),
        "world_truth_candidate_count": truth.get("candidate_count", 0),
        "evidence_states": dict(states),
        "promotion_decision": "none",
        "strategy_authority": False,
    }


def render_markdown(
    summary: dict[str, Any],
    scorecard: list[dict[str, Any]],
    pairwise: list[dict[str, Any]],
    truth: dict[str, Any],
    *,
    bundle_paths: list[Path],
    round_paths: list[Path],
) -> str:
    lines = [
        "# Looper Hazard Comparison — Step 10",
        "",
        f"Generated: {iso_now()}",
        "",
        "**Strategy authority: OFF. Promotion decision: NONE.** This report is evidence collection, not live-caddie logic.",
        "",
        "## Decision summary",
        "",
        f"- Compared **{summary['object_count']}** hazard objects from **{summary['source_count']}** source types.",
        f"- **{summary['spatially_comparable_pair_count']} / {summary['pair_count']}** source pairs currently share a coordinate space that can be compared without inventing a transform.",
        f"- Physical-shot truth observations available: **{summary['truth_observation_count']}**.",
        f"- World-comparable HazardGeometry candidates available: **{summary['world_truth_candidate_count']}**.",
        "- Sources that live only in minimap/image space are compared to other sources in that same space, but are not treated as world-space truth.",
        "- Unity/course-asset geometry with an unproven transform is deliberately excluded from shot-coordinate scoring.",
        "",
        "## Source scorecard",
        "",
        "| Source | Objects | Classes | Spaces | Positive truth | Boundary truth | Safe contradictions | Evidence state |",
        "|---|---:|---|---|---:|---:|---:|---|",
    ]
    for row in scorecard:
        truth_row = row.get("truth") or {}
        classes = ", ".join(f"{k}:{v}" for k, v in sorted((row.get("class_counts") or {}).items())) or "—"
        spaces = ", ".join(sorted((row.get("coordinate_spaces") or {}).keys())) or "—"
        pos = f"{truth_row.get('positive_hits', 0)}/{truth_row.get('positive_hazard_truth', 0)}" if truth_row else "—"
        boundary = f"{truth_row.get('boundary_hits', 0)}/{truth_row.get('boundary_truth', 0)}" if truth_row else "—"
        safe = str(truth_row.get("safe_contradictions", 0)) if truth_row else "—"
        lines.append(f"| {row['source_kind']} | {row['object_count']} | {classes} | {spaces} | {pos} | {boundary} | {safe} | {row['evidence_state']} |")

    lines += [
        "",
        "## Cross-source spatial agreement",
        "",
        "| Source A | Source B | Shared space | Match F1 | Semantic agreement on overlaps | Status |",
        "|---|---|---|---:|---:|---|",
    ]
    for row in pairwise:
        lines.append(
            f"| {row['source_a']} | {row['source_b']} | {row.get('shared_coordinate_space') or '—'} | "
            f"{_fmt_rate(row.get('spatial_match_f1'))} | {_fmt_rate(row.get('semantic_agreement_on_matches'))} | {row['spatial_status']} |"
        )

    mismatches = [
        {**m, "source_a": row["source_a"], "source_b": row["source_b"], "space": row.get("shared_coordinate_space")}
        for row in pairwise
        for m in row.get("semantic_mismatches") or []
    ]
    lines += ["", "## Important contradictions / blockers", ""]
    if mismatches:
        lines.append(f"- {len(mismatches)} spatial overlaps have source-to-source semantic disagreement; inspect `pairwise_comparisons.json` for exact geometry IDs.")
    if any(row.get("evidence_state") == "coordinate-transform-blocked" for row in scorecard):
        lines.append("- At least one course-asset source has useful-looking geometry but an unproven world transform. It remains diagnostic-only.")
    if any(row.get("evidence_state") == "contradicted-on-current-corpus" for row in scorecard):
        lines.append("- At least one world-comparable source contradicts physical shot truth on this corpus. This is a reason to narrow the source's claimed hazard classes, not to hide the miss.")
    if not truth.get("observation_count"):
        lines.append("- No physical shot truth was available in this run. Pairwise agreement alone cannot establish correctness.")
    if not mismatches and not any(row.get("evidence_state") in {"coordinate-transform-blocked", "contradicted-on-current-corpus"} for row in scorecard):
        lines.append("- No hard contradiction was surfaced by the available evidence; corpus size/coverage may still be insufficient.")

    lines += [
        "",
        "## Inputs",
        "",
        f"- HazardGeometry bundles: {len(bundle_paths)}",
        f"- currentRound truth files: {len(round_paths)}",
        "",
        "## Promotion gate",
        "",
        "Nothing in this report is automatically eligible for strategy. Promotion requires an explicit class-specific accuracy threshold, geometry error tolerance relevant to dispersion decisions, known failure behavior, and a representative regression corpus.",
        "",
    ]
    return "\n".join(lines)


def make_zip(run_dir: Path, zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(run_dir.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(run_dir.parent))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Step 10: compare all Looper hazard sources and physical shot truth")
    p.add_argument("--bundle", action="append", default=[], help="HazardGeometry bundle or directory; repeatable")
    p.add_argument("--capture-root", action="append", default=[], help="Capture/output root; repeatable")
    p.add_argument("--current-round", action="append", default=[], help="currentRound.dat or directory; repeatable")
    p.add_argument("--locallow", help="Optional GSPro LocalLow folder for currentRound fallback")
    p.add_argument("--output-root", default=str(Path(__file__).resolve().parent / "output"))
    p.add_argument("--iou-threshold", type=float, default=0.10)
    p.add_argument("--near-tolerance", type=float, default=3.0)
    p.add_argument("--no-zip", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    output_root = Path(args.output_root).expanduser().resolve()
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = output_root / f"hazard_comparison_{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "started_utc": iso_now(),
        "strategy_authority": False,
        "promotion_decision": "none",
        "errors": [],
        "warnings": [],
    }

    bundle_paths = collect_bundle_paths(args.bundle, args.capture_root, output_root)
    objects: list[dict[str, Any]] = []
    adapter_errors: list[dict[str, Any]] = []
    for path in bundle_paths:
        try:
            rows, errors = load_bundle(path)
            objects.extend(rows)
            adapter_errors.extend(errors)
        except Exception as exc:
            manifest["errors"].append(f"bundle:{path}:{type(exc).__name__}:{exc}")
    # Preserve cross-capture objects, but remove exact duplicate geometry IDs.
    objects = list({row["geometry_id"]: row for row in objects}.values())

    round_paths = collect_round_paths(args.current_round, args.capture_root, args.locallow)
    shots, shot_errors = load_shots(round_paths)
    manifest["errors"].extend(f"currentRound:{error}" for error in shot_errors)
    observations = hwt.build_observations(shots)

    inventory = source_inventory(objects)
    pairwise = pairwise_comparisons(objects, args.iou_threshold)
    truth = truth_analysis(objects, observations, near_tolerance=args.near_tolerance)
    scorecard = combined_source_scorecard(inventory, truth)
    summary = build_summary(objects, adapter_errors, inventory, pairwise, truth)

    _write(run_dir / "summary.json", summary)
    _write(run_dir / "source_scorecard.json", {"schema_version": SCHEMA_VERSION, "sources": scorecard, "strategy_authority": False})
    _write(run_dir / "pairwise_comparisons.json", {"schema_version": SCHEMA_VERSION, "pairs": pairwise, "strategy_authority": False})
    _write(run_dir / "shot_truth.json", truth)
    _write(run_dir / "hazard_inventory.json", {
        "schema_version": SCHEMA_VERSION,
        "bundle_paths": [str(p) for p in bundle_paths],
        "object_count": len(objects),
        "objects": objects,
        "adapter_errors": adapter_errors,
        "strategy_authority": False,
    })
    _write(run_dir / "shot_observations.json", {
        "schema_version": SCHEMA_VERSION,
        "current_round_paths": [str(p) for p in round_paths],
        "shot_count": len(shots),
        "observation_count": len(observations),
        "observations": observations,
        "strategy_authority": False,
    })
    report = render_markdown(summary, scorecard, pairwise, truth, bundle_paths=bundle_paths, round_paths=round_paths)
    (run_dir / "REPORT.md").write_text(report, encoding="utf-8")

    manifest["bundle_paths"] = [str(p) for p in bundle_paths]
    manifest["current_round_paths"] = [str(p) for p in round_paths]
    manifest["summary"] = summary
    if not bundle_paths:
        manifest["warnings"].append("No HazardGeometry bundle found; report contains no source comparison.")
    if not observations:
        manifest["warnings"].append("No physical shot truth observations found; report is pairwise-only.")
    manifest["finished_utc"] = iso_now()
    _write(run_dir / "manifest.json", manifest)

    zip_path = output_root / f"hazard_comparison_review_{stamp}.zip"
    if not args.no_zip:
        try:
            make_zip(run_dir, zip_path)
        except Exception as exc:
            manifest["errors"].append(f"zip:{type(exc).__name__}:{exc}")
            _write(run_dir / "manifest.json", manifest)

    print("Looper Hazard Comparison Step 10")
    print(f"Output: {run_dir}")
    if not args.no_zip:
        print(f"Review ZIP: {zip_path}")
    print(f"Hazard objects: {summary['object_count']} across {summary['source_count']} source types")
    print(f"Comparable source pairs: {summary['spatially_comparable_pair_count']}/{summary['pair_count']}")
    print(f"Physical truth observations: {summary['truth_observation_count']}")
    print("Strategy authority: OFF | Promotion: NONE")
    return 0 if not manifest["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
