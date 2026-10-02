#!/usr/bin/env python3
"""Locate the most recent successful tee HoleModel for post-tee use.

POC note: course/hole identity is not yet authoritative in the screen pipeline, so
this cache intentionally uses the newest successful tee capture.  That is suitable
for the current hotkey flow (tee capture, then later shots on the same hole) but must
be replaced/guarded by explicit course+hole identity before broad unattended use.
"""

from __future__ import annotations

import json
from pathlib import Path


def find_latest_hole_model(output_root: str | Path) -> tuple[dict, Path, Path]:
    root = Path(output_root)
    candidates = sorted(
        (p for p in root.glob("tee_capture_*/hole_model.json") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for path in candidates:
        try:
            model = json.loads(path.read_text(encoding="utf-8"))
            if model.get("schema_version") != "tee-hole-model-v0":
                continue
            capture_dir = path.parent
            canonical_name = model.get("canonical_minimap") or "tee_heatmap_minimap.png"
            canonical_path = capture_dir / canonical_name
            if not canonical_path.exists():
                continue
            return model, path, canonical_path
        except Exception:
            continue
    raise RuntimeError(
        f"No usable tee HoleModel found under {root}. Run the tee capture first."
    )
