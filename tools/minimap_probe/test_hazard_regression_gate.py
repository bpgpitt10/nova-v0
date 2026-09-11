import json
from pathlib import Path
import tempfile
import unittest

import hazard_regression_gate as gate


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def make_case(root: Path, case_id="c1", *, contradiction=0, replay_ready=True):
    comp = root / "cases" / case_id / "comparison"
    write_json(comp / "summary.json", {"adapter_error_count": 0})
    write_json(comp / "source_scorecard.json", {"sources": [{
        "source_kind": "red-penalty-cv",
        "object_count": 2,
        "world_comparable_object_count": 2,
        "class_counts": {"penalty_area": 2},
        "truth": {
            "positive_hazard_truth": 2,
            "positive_hits": 2,
            "positive_misses": 0,
            "boundary_truth": 1,
            "boundary_hits": 1,
            "boundary_misses": 0,
            "safe_contradictions": contradiction,
        },
    }]})
    write_json(comp / "pairwise_comparisons.json", {"pairs": []})
    write_json(comp / "shot_truth.json", {})
    return {
        "case_id": case_id,
        "course_key": f"course-{case_id}",
        "comparison_dir": str(comp.relative_to(root)),
        "replay_ready": replay_ready,
    }


def final_policy():
    return {
        "policy_status": "final",
        "promotion_enabled": True,
        "require_replay_ready": True,
        "require_zero_adapter_errors": True,
        "required_hazard_classes": ["penalty_area"],
        "thresholds": {
            "min_case_count": 1,
            "min_course_count": 1,
            "min_positive_truth": 1,
            "min_boundary_truth": 1,
            "positive_truth_hit_rate_min": 0.9,
            "boundary_truth_hit_rate_min": 0.9,
            "pairwise_spatial_f1_median_min": 0.0,
            "pairwise_semantic_agreement_median_min": 0.0,
            "safe_contradictions_max": 0,
            "positive_misses_max": 0,
            "boundary_misses_max": 0,
        },
    }


class HazardRegressionTests(unittest.TestCase):
    def test_empty_corpus_has_no_eligible_sources(self):
        summary = gate.aggregate([])
        self.assertEqual(summary["case_count"], 0)
        self.assertEqual(summary["sources"], [])

    def test_provisional_policy_blocks_perfect_source(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            case = make_case(root)
            write_json(root / "manifest.json", {"cases": [case]})
            cases, errors = gate.load_cases(root / "manifest.json")
            self.assertFalse(errors)
            summary = gate.aggregate(cases)
            policy = final_policy()
            policy["policy_status"] = "provisional"
            policy["promotion_enabled"] = False
            result = gate.evaluate_source(summary["sources"][0], summary, policy)
            self.assertFalse(result["promotion_eligible"])
            self.assertIn("policy-provisional", result["block_reasons"])

    def test_contradiction_blocks_final_policy(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            case = make_case(root, contradiction=1)
            write_json(root / "manifest.json", {"cases": [case]})
            cases, _ = gate.load_cases(root / "manifest.json")
            summary = gate.aggregate(cases)
            result = gate.evaluate_source(summary["sources"][0], summary, final_policy())
            self.assertFalse(result["promotion_eligible"])
            self.assertTrue(any(x.startswith("threshold-failed:safe_contradictions_max") for x in result["block_reasons"]))

    def test_missing_replay_blocks_even_with_final_thresholds(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            case = make_case(root, replay_ready=False)
            write_json(root / "manifest.json", {"cases": [case]})
            cases, _ = gate.load_cases(root / "manifest.json")
            summary = gate.aggregate(cases)
            result = gate.evaluate_source(summary["sources"][0], summary, final_policy())
            self.assertIn("replay-coverage-incomplete", result["block_reasons"])

    def test_complete_synthetic_case_can_become_review_eligible(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            case = make_case(root)
            comp = root / case["comparison_dir"]
            write_json(comp / "pairwise_comparisons.json", {"pairs": [{
                "source_a": "red-penalty-cv",
                "source_b": "other",
                "spatial_status": "comparable",
                "spatial_match_f1": 1.0,
                "semantic_agreement_on_matches": 1.0,
            }]})
            write_json(root / "manifest.json", {"cases": [case]})
            cases, _ = gate.load_cases(root / "manifest.json")
            summary = gate.aggregate(cases)
            result = gate.evaluate_source(summary["sources"][0], summary, final_policy())
            self.assertTrue(result["promotion_eligible"])


if __name__ == "__main__":
    unittest.main()
