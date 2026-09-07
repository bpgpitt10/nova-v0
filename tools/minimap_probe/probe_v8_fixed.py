#!/usr/bin/env python3
"""Launcher for field-proven tee v8 plus non-critical round-identity attachment."""

from __future__ import annotations

from pathlib import Path
import sys

import attach_round_identity
import probe_v8
import target_card_v8  # noqa: F401  (patches target_card.read_target_card after v6 imports)


def _arg_value(name: str) -> str | None:
    try:
        index = sys.argv.index(name)
    except ValueError:
        return None
    if index + 1 >= len(sys.argv):
        return None
    return sys.argv[index + 1]


def main() -> int:
    code = probe_v8.main()
    if code != 0:
        return code

    # Identity OCR is intentionally post-ready/post-review so it cannot destabilize
    # or lengthen the proven tee acquisition critical path.
    output_root = _arg_value("--output-root") or str(Path(__file__).with_name("output"))
    tesseract = _arg_value("--tesseract")
    try:
        identity, warning, _capture = attach_round_identity.attach_latest_round_identity(
            output_root,
            tesseract_path=tesseract,
            debug=("--deep-debug" in sys.argv),
        )
        if identity is not None:
            print(
                "Round identity:       "
                f"{identity.get('course_name') or '?'} | H{identity.get('hole_number') or '?'} | "
                f"PAR {identity.get('par') or '?'} | {identity.get('hole_yards') or '?'} YDS | "
                f"confidence {float(identity.get('confidence') or 0.0):.2f}"
            )
        if warning:
            print(f"Round identity warn:  {warning}")
    except Exception as exc:
        # Tee capture remains valid; cache selection will use an explicit legacy
        # fallback until a later identity-tagged capture exists.
        print(f"Round identity warn:  {exc}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
