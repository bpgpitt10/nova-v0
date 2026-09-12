#!/usr/bin/env python3
"""Post-tee ShotState v1.3: passive minimap AIM first, bounded card fallback second.

Reuses the validated v1.2 capture pipeline. The only policy change is AIM sensing:
when GSPro already draws a separate gray aim marker on the untouched minimap, read
its pixel position and derive distance from the trusted structured PIN distance.
That returns immediately with no LEFT/RIGHT input. If the marker is not separately
visible, v1.2's existing bounded AIM-card summon/verified-return path is unchanged.

This remains simulator-PC field tooling, not production web architecture.
"""
from __future__ import annotations

import os
from pathlib import Path

import gspro_structured
import minimap_aim
import probe as base
import probe_approach_v12 as v12
import probe_v8


def _structured_pin_yds(args) -> float | None:
    raw = os.environ.get("LOOPER_STRUCTURED_PIN_YDS")
    if raw:
        try:
            return float(raw)
        except Exception:
            pass
    try:
        shot = gspro_structured.read_latest_current_round(Path(args.gspro_dir))
        if shot and shot.get("distance_to_pin_yds") is not None:
            return float(shot["distance_to_pin_yds"])
    except Exception:
        pass
    return None


def main() -> int:
    original_acquire = probe_v8._acquire_aim

    def passive_first(screen, args, out):
        pin_yds = _structured_pin_yds(args)
        if pin_yds is not None:
            try:
                minimap, _ = base.crop_minimap(screen, args.roi)
                state, meta = minimap_aim.read_passive_aim(minimap, pin_distance_yds=pin_yds)
                if state is not None:
                    meta = {
                        **meta,
                        "fallback_used": False,
                        "warning": None,
                    }
                    print(
                        f"Passive AIM marker: {state.distance_yds:.1f} yd | "
                        f"confidence={float(meta.get('confidence') or 0.0):.2f} | no GSPro input"
                    )
                    return state, meta, screen
            except Exception as exc:
                print(f"Passive AIM unavailable: {exc}; using bounded AIM-card fallback.")
        state, meta, final_screen = original_acquire(screen, args, out)
        meta = dict(meta or {})
        meta["fallback_used"] = True
        meta["passive_first"] = True
        return state, meta, final_screen

    probe_v8._acquire_aim = passive_first
    try:
        return v12.main()
    finally:
        probe_v8._acquire_aim = original_acquire


if __name__ == "__main__":
    raise SystemExit(main())
