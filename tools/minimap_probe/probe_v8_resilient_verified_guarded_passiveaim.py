#!/usr/bin/env python3
"""Tee v8.4 field probe: tee-race guard + verified Y + passive AIM first.

The validated v8.3 guard remains unchanged. This wrapper only intercepts AIM sensing:
if the untouched/restored minimap exposes GSPro's neutral-gray aim marker and the
watcher supplied a trusted tee PIN distance, derive the aim distance/direction with
no LEFT/RIGHT input. If unavailable, the existing bounded AIM-card summon/verified
return path runs exactly as before.
"""
from __future__ import annotations

import os

import minimap_aim
import probe as base
import probe_v8
import probe_v8_resilient_verified_guarded as guarded


def _tee_pin_yds() -> float | None:
    raw = os.environ.get("LOOPER_TEE_PIN_FALLBACK_YDS")
    if not raw:
        return None
    try:
        return float(raw)
    except Exception:
        return None


def main() -> int:
    original_acquire = probe_v8._acquire_aim

    def passive_first(screen, args, out):
        pin_yds = _tee_pin_yds()
        if pin_yds is not None:
            try:
                minimap, _ = base.crop_minimap(screen, args.roi)
                state, meta = minimap_aim.read_passive_aim(minimap, pin_distance_yds=pin_yds)
                if state is not None:
                    meta = {**meta, "fallback_used": False, "warning": None}
                    print(
                        f"Passive tee AIM marker: {state.distance_yds:.1f} yd | "
                        f"confidence={float(meta.get('confidence') or 0.0):.2f} | no GSPro input"
                    )
                    return state, meta, screen
            except Exception as exc:
                print(f"Passive tee AIM unavailable: {exc}; using bounded AIM-card fallback.")
        state, meta, final_screen = original_acquire(screen, args, out)
        meta = dict(meta or {})
        meta["fallback_used"] = True
        meta["passive_first"] = True
        return state, meta, final_screen

    probe_v8._acquire_aim = passive_first
    try:
        return guarded.main()
    finally:
        probe_v8._acquire_aim = original_acquire


if __name__ == "__main__":
    raise SystemExit(main())
