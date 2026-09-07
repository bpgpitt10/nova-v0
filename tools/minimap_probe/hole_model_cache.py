#!/usr/bin/env python3
"""Select the correct cached tee HoleModel for post-tee use.

Preferred key: GSPro screen identity (course + hole). Newest-capture selection is
kept only as an explicit legacy fallback for old captures that predate identity OCR
or for runs where the screen header could not be read.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
import json
from pathlib import Path

import round_identity as identity_utils


@dataclass
class HoleModelSelection:
    model: dict
    model_path: Path
    canonical_path: Path
    method: str
    confidence: float
    requested_identity: dict | None
    selected_identity: dict | None
    warning: str | None = None

    def meta(self) -> dict:
        return {
            "method": self.method,
            "confidence": self.confidence,
            "requested_identity": self.requested_identity,
            "selected_identity": self.selected_identity,
            "warning": self.warning,
        }


def _config() -> dict:
    path = Path(__file__).resolve().parents[2] / "config" / "looper-live-caddie.json"
    return json.loads(path.read_text(encoding="utf-8"))["hole_model_cache"]


def _load_candidates(output_root: str | Path) -> list[tuple[dict, Path, Path]]:
    root = Path(output_root)
    paths = sorted(
        (p for p in root.glob("tee_capture_*/hole_model.json") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    candidates: list[tuple[dict, Path, Path]] = []
    for path in paths:
        try:
            model = json.loads(path.read_text(encoding="utf-8"))
            if model.get("schema_version") != "tee-hole-model-v0":
                continue
            capture_dir = path.parent
            canonical_name = model.get("canonical_minimap") or "tee_heatmap_minimap.png"
            canonical_path = capture_dir / canonical_name
            if not canonical_path.exists():
                continue
            candidates.append((model, path, canonical_path))
        except Exception:
            continue
    return candidates


def _course_similarity(a: str | None, b: str | None) -> float:
    left = identity_utils.normalize_course_name(a)
    right = identity_utils.normalize_course_name(b)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return SequenceMatcher(None, left, right).ratio()


def _identity_dict(value) -> dict | None:
    if value is None:
        return None
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return dict(value)


def _latest_selection(candidates, requested, method: str, warning: str | None, config: dict) -> HoleModelSelection:
    if not candidates:
        raise RuntimeError("No usable tee HoleModel found. Run the tee capture first.")
    model, path, canonical = candidates[0]
    confidence = (
        float(config["legacy_latest_confidence"])
        if warning
        else float(config["latest_without_warning_confidence"])
    )
    return HoleModelSelection(
        model=model,
        model_path=path,
        canonical_path=canonical,
        method=method,
        confidence=confidence,
        requested_identity=requested,
        selected_identity=model.get("round_identity"),
        warning=warning,
    )


def _fallback_without_course(
    tagged_same_hole,
    *,
    requested: dict,
    yard_tolerance: float,
    config: dict,
) -> HoleModelSelection | None:
    """Use non-course fields only when they identify one unambiguous cached hole."""
    requested_par = requested.get("par")
    requested_yards = requested.get("hole_yards")

    strong = []
    for model, path, canonical in tagged_same_hole:
        stored = model.get("round_identity") or {}
        par_ok = (
            requested_par is not None
            and stored.get("par") is not None
            and int(stored["par"]) == int(requested_par)
        )
        yards_ok = (
            requested_yards is not None
            and stored.get("hole_yards") is not None
            and abs(float(stored["hole_yards"]) - float(requested_yards)) <= yard_tolerance
        )
        if par_ok and yards_ok:
            strong.append((model, path, canonical, stored))

    if len(strong) == 1:
        model, path, canonical, stored = strong[0]
        return HoleModelSelection(
            model=model,
            model_path=path,
            canonical_path=canonical,
            method="hole-par-yard-fallback",
            confidence=float(config["missing_course_par_yard_confidence"]),
            requested_identity=requested,
            selected_identity=stored,
            warning="course name OCR was unavailable; selected the only matching hole/par/yardage model",
        )

    if len(tagged_same_hole) == 1:
        model, path, canonical = tagged_same_hole[0]
        return HoleModelSelection(
            model=model,
            model_path=path,
            canonical_path=canonical,
            method="unique-hole-fallback",
            confidence=float(config["unique_hole_confidence"]),
            requested_identity=requested,
            selected_identity=model.get("round_identity"),
            warning="course name OCR was unavailable; only one tagged model exists for this hole number",
        )
    return None


def find_hole_model(
    output_root: str | Path,
    *,
    identity: dict | object | None = None,
) -> HoleModelSelection:
    config = _config()
    candidates = _load_candidates(output_root)
    if not candidates:
        raise RuntimeError(f"No usable tee HoleModel found under {Path(output_root)}. Run the tee capture first.")

    requested = _identity_dict(identity)
    if not requested or requested.get("hole_number") is None:
        if not bool(config["allow_latest_when_current_identity_unavailable"]):
            raise RuntimeError("Current GSPro course/hole identity is unavailable; refusing newest-HoleModel fallback.")
        return _latest_selection(
            candidates,
            requested,
            "latest-current-identity-unavailable",
            "current course/hole header was unavailable; selected newest tee HoleModel",
            config,
        )

    requested_hole = int(requested["hole_number"])
    requested_course = requested.get("course_name")
    requested_par = requested.get("par")
    requested_yards = requested.get("hole_yards")
    similarity_min = float(config["course_name_similarity_min"])
    yard_tolerance = float(config["hole_yardage_tolerance_yds"])

    identity_tagged = [row for row in candidates if (row[0].get("round_identity") or {}).get("hole_number") is not None]
    same_hole = [
        row for row in identity_tagged
        if int((row[0].get("round_identity") or {}).get("hole_number") or -1) == requested_hole
    ]

    if not requested_course:
        fallback = _fallback_without_course(
            same_hole,
            requested=requested,
            yard_tolerance=yard_tolerance,
            config=config,
        )
        if fallback is not None:
            return fallback
        if not identity_tagged and bool(config["allow_legacy_latest_when_no_identity_tagged_models"]):
            return _latest_selection(
                candidates,
                requested,
                "legacy-latest-no-tagged-models",
                "cached tee captures predate course/hole identity; selected newest legacy HoleModel",
                config,
            )
        raise RuntimeError(
            f"Course name OCR was unavailable and cached hole {requested_hole} is ambiguous. "
            "Refusing to silently use the wrong HoleModel."
        )

    scored = []
    for model, path, canonical in same_hole:
        stored = model.get("round_identity") or {}
        stored_course = stored.get("course_name")
        if not stored_course:
            continue
        course_similarity = _course_similarity(requested_course, stored_course)
        if course_similarity < similarity_min:
            continue

        score = (
            float(config["base_course_hole_confidence"])
            + float(config["course_similarity_weight"]) * course_similarity
        )
        method = "course-hole-exact" if course_similarity >= 0.999 else "course-hole-fuzzy"
        if requested_par is not None and stored.get("par") is not None and int(stored["par"]) == int(requested_par):
            score += float(config["par_match_bonus"])
        if requested_yards is not None and stored.get("hole_yards") is not None:
            diff = abs(float(stored["hole_yards"]) - float(requested_yards))
            if diff <= yard_tolerance:
                score += float(config["yardage_match_bonus"]) * (1.0 - diff / max(yard_tolerance, 1.0))
        scored.append((score, method, model, path, canonical, stored))

    if scored:
        score, method, model, path, canonical, stored = max(scored, key=lambda row: (row[0], row[3].stat().st_mtime))
        return HoleModelSelection(
            model=model,
            model_path=path,
            canonical_path=canonical,
            method=method,
            confidence=min(1.0, float(score)),
            requested_identity=requested,
            selected_identity=stored,
            warning=None,
        )

    if not identity_tagged and bool(config["allow_legacy_latest_when_no_identity_tagged_models"]):
        return _latest_selection(
            candidates,
            requested,
            "legacy-latest-no-tagged-models",
            "cached tee captures predate course/hole identity; selected newest legacy HoleModel",
            config,
        )

    raise RuntimeError(
        f"No cached tee HoleModel matched current identity: {requested.get('course_name') or '?'} "
        f"hole {requested_hole}. Refusing to silently use another hole."
    )


def find_latest_hole_model(output_root: str | Path) -> tuple[dict, Path, Path]:
    """Compatibility helper for older probes; new code should call find_hole_model()."""
    candidates = _load_candidates(output_root)
    if not candidates:
        raise RuntimeError(f"No usable tee HoleModel found under {Path(output_root)}. Run the tee capture first.")
    return candidates[0]
