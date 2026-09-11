#!/usr/bin/env python3
"""Step 12: regression-corpus and promotion-gate framework for Looper hazards.

Consumes immutable Step 10 comparison snapshots registered in a corpus manifest.
This scaffold deliberately does not grant strategy authority. A provisional policy,
unset thresholds, missing replay coverage, malformed cases, or metric failures all
block promotion.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
from pathlib import Path
from statistics import median
from typing import Any

SCHEMA_VERSION = "looper-hazard-regression-v0"
STRATEGY_AUTHORITY = False


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _read(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def _write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    temp.replace(path)


def _rate(num: int, den: int) -> float | None:
    return (num / den) if den else None


def _finite(value: Any) -> float | None:
    try:
        out = float(value)
    except Exception:
        return None
    return out if math.isfinite(out) else None


def _resolve(base: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


def load_cases(manifest_path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    manifest = _read(manifest_path)
    base = manifest_path.parent.resolve()
    rows: list[dict[str, Any]] = []
    errors: list[str] = []
    for index, case in enumerate(manifest.get("cases") or []):
        case_id = str(case.get("case_id") or f"case-{index+1}")
        raw = case.get("comparison_dir")
        if not raw:
            errors.append(f"{case_id}:missing-comparison-dir")
            continue
        directory = _resolve(base, str(raw))
        required = {
            "summary": directory / "summary.json",
            "scorecard": directory / "source_scorecard.json",
            "pairwise": directory / "pairwise_comparisons.json",
            "truth": directory / "shot_truth.json",
        }
        missing = [name for name, path in required.items() if not path.is_file()]
        if missing:
            errors.append(f"{case_id}:missing:{','.join(missing)}")
            continue
        try:
            rows.append({
                "case": dict(case),
                "summary": _read(required["summary"]),
                "scorecard": _read(required["scorecard"]),
                "pairwise": _read(required["pairwise"]),
                "truth": _read(required["truth"]),
            })
        except Exception as exc:
            errors.append(f"{case_id}:read-error:{type(exc).__name__}:{exc}")
    return rows, errors


def aggregate(cases: list[dict[str, Any]]) -> dict[str, Any]:
    sources: dict[str, dict[str, Any]] = {}
    courses: set[str] = set()
    hazard_classes: set[str] = set()
    replay_ready_cases = 0
    adapter_errors = 0

    for wrapped in cases:
        meta = wrapped["case"]
        course = meta.get("course_key") or meta.get("course_name")
        if course:
            courses.add(str(course))
        if bool(meta.get("replay_ready")):
            replay_ready_cases += 1
        adapter_errors += int(wrapped["summary"].get("adapter_error_count", 0) or 0)

        for row in wrapped["scorecard"].get("sources") or []:
            source = str(row.get("source_kind") or "unknown")
            target = sources.setdefault(source, {
                "source_kind": source,
                "case_count": 0,
                "object_count": 0,
                "world_comparable_object_count": 0,
                "hazard_classes": set(),
                "positive_truth": 0,
                "positive_hits": 0,
                "positive_misses": 0,
                "boundary_truth": 0,
                "boundary_hits": 0,
                "boundary_misses": 0,
                "safe_contradictions": 0,
                "pairwise_f1": [],
                "semantic_agreement": [],
            })
            target["case_count"] += 1
            target["object_count"] += int(row.get("object_count", 0) or 0)
            target["world_comparable_object_count"] += int(row.get("world_comparable_object_count", 0) or 0)
            for klass in (row.get("class_counts") or {}).keys():
                target["hazard_classes"].add(str(klass))
                hazard_classes.add(str(klass))
            truth = row.get("truth") or {}
            target["positive_truth"] += int(truth.get("positive_hazard_truth", 0) or 0)
            target["positive_hits"] += int(truth.get("positive_hits", 0) or 0)
            target["positive_misses"] += int(truth.get("positive_misses", 0) or 0)
            target["boundary_truth"] += int(truth.get("boundary_truth", 0) or 0)
            target["boundary_hits"] += int(truth.get("boundary_hits", 0) or 0)
            target["boundary_misses"] += int(truth.get("boundary_misses", 0) or 0)
            target["safe_contradictions"] += int(truth.get("safe_contradictions", 0) or 0)

        for pair in wrapped["pairwise"].get("pairs") or []:
            if pair.get("spatial_status") != "comparable":
                continue
            for source in (pair.get("source_a"), pair.get("source_b")):
                if source not in sources:
                    continue
                f1 = _finite(pair.get("spatial_match_f1"))
                semantic = _finite(pair.get("semantic_agreement_on_matches"))
                if f1 is not None:
                    sources[source]["pairwise_f1"].append(f1)
                if semantic is not None:
                    sources[source]["semantic_agreement"].append(semantic)

    normalized = []
    for source, row in sorted(sources.items()):
        positive_rate = _rate(row["positive_hits"], row["positive_truth"])
        boundary_rate = _rate(row["boundary_hits"], row["boundary_truth"])
        normalized.append({
            **{k: v for k, v in row.items() if k not in {"hazard_classes", "pairwise_f1", "semantic_agreement"}},
            "hazard_classes": sorted(row["hazard_classes"]),
            "positive_truth_hit_rate": positive_rate,
            "boundary_truth_hit_rate": boundary_rate,
            "pairwise_spatial_f1_median": median(row["pairwise_f1"]) if row["pairwise_f1"] else None,
            "pairwise_semantic_agreement_median": median(row["semantic_agreement"]) if row["semantic_agreement"] else None,
        })
    return {
        "case_count": len(cases),
        "course_count": len(courses),
        "replay_ready_case_count": replay_ready_cases,
        "adapter_error_count": adapter_errors,
        "hazard_classes": sorted(hazard_classes),
        "sources": normalized,
    }


def evaluate_source(source: dict[str, Any], aggregate_summary: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    reasons: list[str] = []
    thresholds = policy.get("thresholds") or {}

    if policy.get("policy_status") != "final":
        reasons.append("policy-provisional")
    if policy.get("promotion_enabled") is not True:
        reasons.append("promotion-disabled")
    if policy.get("require_replay_ready") and aggregate_summary["replay_ready_case_count"] < aggregate_summary["case_count"]:
        reasons.append("replay-coverage-incomplete")
    if policy.get("require_zero_adapter_errors") and aggregate_summary["adapter_error_count"]:
        reasons.append("adapter-errors-present")

    mappings = {
        "min_case_count": ("case_count", ">="),
        "min_course_count": ("__course_count__", ">="),
        "min_positive_truth": ("positive_truth", ">="),
        "min_boundary_truth": ("boundary_truth", ">="),
        "positive_truth_hit_rate_min": ("positive_truth_hit_rate", ">="),
        "boundary_truth_hit_rate_min": ("boundary_truth_hit_rate", ">="),
        "pairwise_spatial_f1_median_min": ("pairwise_spatial_f1_median", ">="),
        "pairwise_semantic_agreement_median_min": ("pairwise_semantic_agreement_median", ">="),
        "safe_contradictions_max": ("safe_contradictions", "<="),
        "positive_misses_max": ("positive_misses", "<="),
        "boundary_misses_max": ("boundary_misses", "<="),
    }
    for policy_key, (metric_key, op) in mappings.items():
        threshold = thresholds.get(policy_key)
        if threshold is None:
            reasons.append(f"threshold-unset:{policy_key}")
            continue
        value = aggregate_summary["course_count"] if metric_key == "__course_count__" else source.get(metric_key)
        if value is None:
            reasons.append(f"metric-unavailable:{metric_key}")
            continue
        passed = value >= threshold if op == ">=" else value <= threshold
        if not passed:
            reasons.append(f"threshold-failed:{policy_key}:{value}")

    required_classes = set(policy.get("required_hazard_classes") or [])
    missing_classes = sorted(required_classes - set(source.get("hazard_classes") or []))
    if missing_classes:
        reasons.append("missing-hazard-classes:" + ",".join(missing_classes))

    return {
        "source_kind": source["source_kind"],
        "promotion_eligible": not reasons,
        "block_reasons": reasons,
        "metrics": source,
        "strategy_authority": False,
    }


def render_markdown(summary: dict[str, Any], gates: list[dict[str, Any]], policy: dict[str, Any], case_errors: list[str]) -> str:
    lines = [
        "# Looper Hazard Regression — Step 12",
        "",
        f"Generated: {iso_now()}",
        "",
        "**Strategy authority: OFF.** Promotion remains blocked unless every configured gate passes under a final policy.",
        "",
        f"- Corpus cases: **{summary['case_count']}** across **{summary['course_count']}** courses.",
        f"- Replay-ready cases: **{summary['replay_ready_case_count']} / {summary['case_count']}**.",
        f"- Policy status: **{policy.get('policy_status', 'unknown')}**.",
        f"- Corpus errors: **{len(case_errors)}**.",
        "",
        "## Source gates",
        "",
        "| Source | Cases | Positive truth | Boundary truth | Safe contradictions | Eligible? |",
        "|---|---:|---:|---:|---:|---|",
    ]
    for gate in gates:
        m = gate["metrics"]
        lines.append(
            f"| {gate['source_kind']} | {m['case_count']} | {m['positive_hits']}/{m['positive_truth']} | "
            f"{m['boundary_hits']}/{m['boundary_truth']} | {m['safe_contradictions']} | "
            f"{'YES' if gate['promotion_eligible'] else 'NO'} |"
        )
    lines += ["", "## Blockers", ""]
    if case_errors:
        lines += [f"- Corpus: {error}" for error in case_errors]
    for gate in gates:
        for reason in gate["block_reasons"]:
            lines.append(f"- {gate['source_kind']}: {reason}")
    if not gates:
        lines.append("- No source evidence is registered yet.")
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description="Step 12 hazard regression corpus and promotion gate")
    p.add_argument("--manifest", default=str(here / "hazard_regression_corpus" / "manifest.json"))
    p.add_argument("--policy", default=str(here / "hazard_regression_policy.json"))
    p.add_argument("--output-root", default=str(here / "output"))
    return p.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = Path(args.manifest).expanduser().resolve()
    policy_path = Path(args.policy).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    cases, case_errors = load_cases(manifest_path)
    policy = _read(policy_path)
    summary = aggregate(cases)
    gates = [evaluate_source(source, summary, policy) for source in summary["sources"]]
    overall_eligible = bool(gates) and not case_errors and all(g["promotion_eligible"] for g in gates)

    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = output_root / f"hazard_regression_{stamp}"
    payload = {
        "schema_version": SCHEMA_VERSION,
        "generated_utc": iso_now(),
        "policy_status": policy.get("policy_status"),
        "summary": summary,
        "source_gates": gates,
        "case_errors": case_errors,
        "overall_promotion_eligible": overall_eligible,
        "promotion_decision": "eligible-for-explicit-review" if overall_eligible else "blocked",
        "strategy_authority": False,
    }
    _write(run_dir / "summary.json", payload)
    (run_dir / "REPORT.md").write_text(render_markdown(summary, gates, policy, case_errors), encoding="utf-8")

    print("Looper Hazard Regression Step 12")
    print(f"Output: {run_dir}")
    print(f"Cases: {summary['case_count']} | Sources: {len(gates)}")
    print(f"Promotion: {'ELIGIBLE FOR EXPLICIT REVIEW' if overall_eligible else 'BLOCKED'}")
    print("Strategy authority: OFF")
    return 0 if not case_errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
