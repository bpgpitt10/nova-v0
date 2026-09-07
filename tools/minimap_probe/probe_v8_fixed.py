#!/usr/bin/env python3
"""Launcher for v8 with the field-validated target-card OCR patch applied."""

import probe_v8
import target_card_v8  # noqa: F401  (patches target_card.read_target_card after v6 imports)


if __name__ == "__main__":
    raise SystemExit(probe_v8.main())
