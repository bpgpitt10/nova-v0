#!/usr/bin/env python3
"""Step 11 tee probe with verified Y state plus an inside-capture tee race guard.

The watcher may correctly decide that a tee is ready and still lose the race if the
player hits before the child capture actually freezes its first frame. The 2026-09-11
Hole 1 evidence did exactly that: watcher readiness said tee, but the saved minimap
already showed Fairway.

This wrapper validates the *actual first frame consumed by the tee probe*. A clearly
recognized non-tee minimap surface aborts before Y/AIM actuation. An unrecognized OCR
result remains fail-soft because watcher fusion already performed the outer gate.
"""
from __future__ import annotations

import sys

import minimap_surface
import probe as base
import probe_v8_resilient_verified as verified


def _cli_value(flag: str) -> str | None:
    try:
        idx = sys.argv.index(flag)
    except ValueError:
        return None
    return sys.argv[idx + 1] if idx + 1 < len(sys.argv) else None


def main() -> int:
    original_capture = base.capture_monitor
    first = True
    tesseract = _cli_value("--tesseract")
    roi = _cli_value("--roi")

    def guarded_capture(monitor: int):
        nonlocal first
        screen = original_capture(monitor)
        if not first:
            return screen
        first = False
        try:
            minimap, _ = base.crop_minimap(screen, roi)
            surface = minimap_surface.read_minimap_surface(
                minimap,
                tesseract_path=tesseract,
            )
            if surface.recognized and not surface.is_tee:
                raise RuntimeError(
                    "TEE CAPTURE RACE BLOCKED: actual child-capture first frame is "
                    f"{surface.label or surface.normalized_label!r}, not Tee. "
                    "No Y/AIM actuation was attempted."
                )
            if surface.recognized and surface.is_tee:
                print(f"Inside-capture tee guard: PASS ({surface.label or 'tee'}, confidence={surface.confidence:.2f})")
            else:
                print(
                    "Inside-capture tee guard: surface OCR unconfirmed; proceeding fail-soft "
                    "under watcher readiness authority."
                )
        except RuntimeError:
            raise
        except Exception as exc:
            print(f"Inside-capture tee guard: unavailable ({exc}); proceeding fail-soft under watcher readiness authority.")
        return screen

    base.capture_monitor = guarded_capture
    try:
        return verified.main()
    finally:
        base.capture_monitor = original_capture


if __name__ == "__main__":
    raise SystemExit(main())
