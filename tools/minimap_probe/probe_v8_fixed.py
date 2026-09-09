#!/usr/bin/env python3
"""Launcher for v8 with field-validated target-card OCR and collision-proof output."""
from datetime import datetime
from pathlib import Path

import probe_v8
import target_card_v8  # noqa: F401  (patches target_card.read_target_card after v6 imports)


def _capture_dir(root: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    path = Path(root) / f"tee_capture_{stamp}"
    path.mkdir(parents=True, exist_ok=False)
    return path


probe_v8._capture_dir = _capture_dir


if __name__ == "__main__":
    raise SystemExit(probe_v8.main())
