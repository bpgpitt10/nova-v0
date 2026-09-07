#!/usr/bin/env python3
"""Post-process a successful tee capture with GSPro course/hole identity.

Kept outside probe_v8's critical path so the field-proven tee orchestrator remains
unchanged.  Identity OCR runs only after HoleModel/ShotState and review PNGs exist.
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2

import round_identity


def _latest_capture(output_root: str | Path) -> Path:
    root = Path(output_root)
    captures = sorted(
        (p for p in root.glob("tee_capture_*") if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not captures:
        raise RuntimeError(f"No tee capture found under {root}")
    return captures[0]


def _patch_json(path: Path, identity_payload: dict | None, warning: str | None) -> None:
    if not path.exists():
        return
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["round_identity"] = identity_payload
    payload["round_identity_warning"] = warning
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def attach_latest_round_identity(
    output_root: str | Path,
    *,
    tesseract_path: str | None = None,
    debug: bool = False,
) -> tuple[dict | None, str | None, Path]:
    capture = _latest_capture(output_root)
    screen_path = capture / "tee_initial_screen.png"
    screen = cv2.imread(str(screen_path), cv2.IMREAD_COLOR)
    if screen is None:
        raise RuntimeError(f"Could not read {screen_path}")

    identity, warning = round_identity.try_read_round_identity(
        screen,
        tesseract_path=tesseract_path,
        debug_dir=(capture if debug else None),
    )
    identity_payload = identity.to_dict() if identity is not None else None

    _patch_json(capture / "hole_model.json", identity_payload, warning)
    _patch_json(capture / "shot_state.json", identity_payload, warning)
    _patch_json(capture / "tee_capture_meta.json", identity_payload, warning)
    return identity_payload, warning, capture
