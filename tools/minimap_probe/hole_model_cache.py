#!/usr/bin/env python3
"""Load tee HoleModels for post-tee geometry.

Unattended watcher code should pass an explicit HoleModel path. The legacy
latest-by-time lookup remains available only for manual/hotkey diagnostics.
"""
from __future__ import annotations

import json
from pathlib import Path


def load_hole_model(path_or_dir: str | Path) -> tuple[dict, Path, Path]:
    path = Path(path_or_dir)
    if path.is_dir():
        path = path / "hole_model.json"
    if not path.exists():
        raise RuntimeError(f"HoleModel not found: {path}")
    try:
        model = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Could not read HoleModel {path}: {exc}") from exc
    if model.get("schema_version") != "tee-hole-model-v0":
        raise RuntimeError(
            f"Unsupported HoleModel schema {model.get('schema_version')!r} at {path}"
        )
    capture_dir = path.parent
    canonical_name = model.get("canonical_minimap") or "tee_heatmap_minimap.png"
    canonical_path = capture_dir / str(canonical_name)
    if not canonical_path.exists():
        raise RuntimeError(f"Canonical minimap missing for HoleModel: {canonical_path}")
    return model, path, canonical_path


def find_latest_hole_model(output_root: str | Path) -> tuple[dict, Path, Path]:
    """Legacy/manual fallback. Watcher code must not use this for unattended play."""
    root = Path(output_root)
    candidates = sorted(
        (p for p in root.glob("tee_capture_*/hole_model.json") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for path in candidates:
        try:
            return load_hole_model(path)
        except Exception:
            continue
    raise RuntimeError(
        f"No usable tee HoleModel found under {root}. Run the tee capture first."
    )
