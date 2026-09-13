#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import zipfile

import package_partial_validation_v0 as pkg


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_packages_only_requested_session() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        state = root / "round_watch_state.json"
        write_json(state, {"session_id": "round-test"})

        tee = root / "tee_capture_20260913_140000"
        write_json(tee / "capture_context.json", {
            "watcher_session_id": "round-test",
            "capture_type": "tee",
            "hole_number": 1,
            "shot_number": 1,
            "tagged_local_epoch": 1,
        })
        write_json(tee / "shot_state.json", {
            "pin": {"distance_yds": 410, "elevation_delta_ft": 12},
            "aim": {"distance_yds": 240, "elevation_delta_ft": 6},
            "aim_acquisition": {"status": "auto-summoned", "verified_return": True},
            "wind": None,
        })
        write_json(tee / "hole_model.json", {
            "green": {
                "heatmap_confidence": 0.91,
                "target_green_area_px": 120,
                "target_green_bbox": [1, 2, 10, 8],
                "pin_distance_to_mask_px": 0.0,
            }
        })
        (tee / "tee_initial_screen.png").write_bytes(b"fake-png")

        approach = root / "approach_capture_20260913_140100_000001"
        write_json(approach / "capture_context.json", {
            "watcher_session_id": "round-test",
            "capture_type": "post-tee",
            "hole_number": 1,
            "shot_number": 2,
            "tagged_local_epoch": 2,
        })
        write_json(approach / "shot_state.json", {
            "pin": {"distance_yds": 155, "elevation_delta_ft": 9},
            "aim": {"distance_yds": 150, "elevation_delta_ft": 7},
            "aim_acquisition": {"status": "auto-summoned", "verified_return": True},
            "lie_slope": {"signed_up_down_deg": 1.2},
            "canonical_geometry_attempted": True,
            "canonical_geometry_trusted": True,
            "canonical_geometry": {
                "registration": {"confidence": 0.95, "inliers": 44},
                "pin_distance_crosscheck": {"ok": True},
                "green_visibility": {"visible": True},
                "w_recovery_recommended": False,
            },
            "wind": None,
        })

        other = root / "tee_capture_other"
        write_json(other / "capture_context.json", {
            "watcher_session_id": "round-other",
            "capture_type": "tee",
            "hole_number": 9,
            "tagged_local_epoch": 3,
        })
        (other / "do_not_include.txt").write_text("no", encoding="utf-8")

        captures = pkg.matching_captures(root, "round-test")
        assert [p.name for p, _ in captures] == [tee.name, approach.name]
        manifest = pkg.build_manifest("round-test", captures, pkg.read_json(state))
        assert manifest["capture_counts"] == {"total": 2, "tee": 1, "post_tee": 1, "holes": 1}
        assert manifest["captures"][0]["green"]["heatmap_confidence"] == 0.91
        assert manifest["captures"][1]["posttee_geometry"]["trusted"] is True
        assert manifest["captures"][1]["posttee_geometry"]["green_visible"] is True

        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        zip_path = root / "package.zip"
        pkg.write_zip(zip_path, root, captures, manifest_path, state)
        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
        assert "partial_validation_manifest.json" in names
        assert f"captures/{tee.name}/tee_initial_screen.png" in names
        assert "captures/tee_capture_other/do_not_include.txt" not in names


if __name__ == "__main__":
    test_packages_only_requested_session()
    print("PASS test_packages_only_requested_session")
