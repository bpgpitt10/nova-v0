#!/usr/bin/env python3
"""Fast, network-free contract tests for tools/build_course.py."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import build_course as pipeline


def sample_config() -> dict:
    return {
        "schemaVersion": "looper-course-build-config-v1",
        "courseId": "sample-course-city-state",
        "courseName": "Sample Course",
        "location": "Somewhere, ST",
        "slug": "sample-course",
        "osmCourseElement": {"type": "way", "id": 123456},
        "terrain": {"provider": "usgs-3dep-1m"},
    }


def test_config_and_plan() -> None:
    config = sample_config()
    pipeline.validate_config(config)
    holes = pipeline.parse_holes("1,6,10-12")
    assert holes == [1, 6, 10, 11, 12]

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp) / "staging"
        candidate = pipeline.candidate_dir_for(config, root)
        pipeline.ensure_safe_candidate_dir(candidate, root)
        plan = pipeline.build_plan(
            config,
            candidate_dir=candidate,
            terrain_mode="auto",
            terrain_holes=pipeline.ALL_HOLES,
        )
        assert plan["publishesRuntimePackage"] is False
        assert plan["terrain"]["enabled"] is True
        assert plan["terrain"]["provider"] == "usgs-3dep-1m"
        assert plan["stages"] == [
            "resolve-course-and-hole-family",
            "compile-canonical-v7-geometry",
            "build-current-frame-terrain",
            "compose-geometry-and-terrain",
            "validate-candidate",
        ]
        assert "public/course-geometry" not in str(candidate).replace("\\", "/")


def test_terrain_modes() -> None:
    config = sample_config()
    enabled, provider, note = pipeline.terrain_decision(config, "auto")
    assert enabled and provider == "usgs-3dep-1m" and note is None

    enabled, provider, note = pipeline.terrain_decision(config, "off")
    assert not enabled and provider == "usgs-3dep-1m" and note

    unsupported = sample_config()
    unsupported["terrain"] = {"provider": "future-provider"}
    enabled, provider, note = pipeline.terrain_decision(unsupported, "auto")
    assert not enabled and provider == "future-provider" and "not supported" in note

    try:
        pipeline.terrain_decision(unsupported, "required")
    except pipeline.BuildError:
        pass
    else:
        raise AssertionError("required terrain accepted unsupported provider")


def test_reject_runtime_publish_path() -> None:
    config = sample_config()
    runtime = pipeline.REPO_ROOT / "public" / "course-geometry"
    candidate = runtime / config["slug"] / "candidate"
    try:
        pipeline.ensure_safe_candidate_dir(candidate, runtime)
    except pipeline.BuildError:
        pass
    else:
        raise AssertionError("build-course accepted public/course-geometry as staging root")


def test_plan_on_real_augusta_config() -> None:
    config_path = pipeline.REPO_ROOT / "config" / "course-geometry" / "augusta-national-v1.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    pipeline.validate_config(config)
    candidate = pipeline.candidate_dir_for(config, pipeline.DEFAULT_OUTPUT_ROOT)
    plan = pipeline.build_plan(
        config,
        candidate_dir=candidate,
        terrain_mode="auto",
        terrain_holes=pipeline.ALL_HOLES,
    )
    assert plan["courseId"] == "augusta-national-augusta-ga"
    assert plan["terrain"]["enabled"] is True
    assert plan["publishesRuntimePackage"] is False


def main() -> int:
    test_config_and_plan()
    test_terrain_modes()
    test_reject_runtime_publish_path()
    test_plan_on_real_augusta_config()
    print("build-course pipeline contract: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
