#!/usr/bin/env python3
"""GSPro post-tee ShotState probe v1: canonical geometry + green visibility.

v1 keeps v0's proven behavior (no W, no Y) and adds a read-only geometry layer:
- register the current minimap back to the latest tee HoleModel;
- express the current ball in canonical hole coordinates;
- cross-check canonical remaining distance against the screen PIN card;
- project the cached target-green footprint into the current minimap;
- report whether W recovery would be recommended, WITHOUT pressing W.

This lets the next sim session validate the decision logic before UI actuation is
allowed to change zoom.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

import cv2

import lie_state
import posttee_geometry
import probe as base
import probe_v8
import target_card_v8  # noqa: F401; field-validated target-card OCR


class Timer:
    def __init__(self) -> None:
        self.start = time.perf_counter()
        self.phase_ms: dict[str, float] = {}

    def call(self, name, fn, *args, **kwargs):
        t0 = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            self.phase_ms[name] = round((time.perf_counter() - t0) * 1000.0, 1)

    def elapsed_ms(self) -> float:
        return round((time.perf_counter() - self.start) * 1000.0, 1)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GSPro post-tee ShotState probe v1")
    p.add_argument("--monitor", type=int, default=1)
    p.add_argument("--roi", help="Override minimap crop as x,y,w,h in screen pixels.")
    p.add_argument("--lie-roi", help="Override lie footer as x,y,w,h in screen pixels.")
    p.add_argument("--tesseract", help="Explicit path to tesseract.exe if auto-discovery fails.")
    p.add_argument("--no-aim-summon", action="store_true")
    p.add_argument("--aim-pulse-ms", type=float, default=45.0)
    p.add_argument("--aim-settle-ms", type=float, default=60.0)
    p.add_argument("--aim-return-tolerance-px", type=float, default=1.5)
    p.add_argument("--aim-max-correction-ms", type=float, default=20.0)
    p.add_argument("--aim-max-corrections", type=int, default=2)
    p.add_argument("--deep-debug", action="store_true")
    p.add_argument("--output-root", default=str(Path(__file__).with_name("output")))
    return p.parse_args()


def _out_dir(root: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    p = Path(root) / f"approach_capture_{stamp}"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _state_dict(state):
    if state is None:
        return None
    return {
        "distance_yds": state.distance_yds,
        "elevation_raw": state.elevation_raw,
        "elevation_direction": state.elevation_direction,
        "elevation_delta_ft": state.elevation_delta_ft,
        "elevation_delta_yds": state.elevation_delta_yds,
        "source": state.source,
    }


def _save_card(path: Path, screen, state) -> None:
    if state is None:
        return
    x, y, w, h = state.card_bbox
    crop = screen[y:y+h, x:x+w]
    if crop.size:
        cv2.imwrite(str(path), crop)


def main() -> int:
    args = parse_args()
    out = _out_dir(args.output_root)
    timer = Timer()

    try:
        initial = timer.call("initial_capture", base.capture_monitor, args.monitor)
        minimap, minimap_bbox = base.crop_minimap(initial, args.roi)

        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="approach") as ex:
            pin_future = ex.submit(
                timer.call,
                "pin_card_ocr",
                probe_v8._read_card_type,
                initial,
                "pin",
                args,
                None,
                True,
            )
            lie_future = ex.submit(
                timer.call,
                "lie_ocr",
                lie_state.read_lie_state,
                initial,
                args.tesseract,
                args.lie_roi,
                None,
            )

            t0 = time.perf_counter()
            aim_state, aim_meta, aim_screen = probe_v8._acquire_aim(initial, args, out)
            timer.phase_ms["aim_acquisition"] = round((time.perf_counter() - t0) * 1000.0, 1)

            pin_state = pin_future.result()
            lie = lie_future.result()

        geometry = None
        geometry_warning = None
        try:
            geometry = timer.call(
                "canonical_geometry",
                posttee_geometry.analyze,
                current_minimap=minimap,
                pin_distance_yds=float(pin_state.distance_yds),
                output_root=args.output_root,
            )
        except Exception as exc:
            geometry_warning = str(exc)

        state_ready_ms = timer.elapsed_ms()

        payload = {
            "schema_version": "post-tee-shot-state-v1",
            "capture_mode": "post-tee",
            "pin": _state_dict(pin_state),
            "aim": _state_dict(aim_state),
            "aim_acquisition": aim_meta,
            "lie_slope": asdict(lie),
            "minimap": {
                "as_presented": "approach_minimap.png",
                "bbox": list(minimap_bbox),
                "zoom_changed": False,
                "heatmap_toggled": False,
            },
            "canonical_geometry": geometry,
            "canonical_geometry_warning": geometry_warning,
            "wind": None,
            "wind_note": "Use existing Looper wind source; not duplicated in approach probe v1.",
            "performance": {
                "state_ready_ms": state_ready_ms,
                "phase_ms": timer.phase_ms,
                "parallel_ocr": True,
            },
            "created_local": datetime.now().isoformat(timespec="seconds"),
        }

        (out / "shot_state.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

        t0 = time.perf_counter()
        cv2.imwrite(str(out / "approach_initial_screen.png"), initial)
        cv2.imwrite(str(out / "approach_minimap.png"), minimap)
        x, y, w, h = lie.footer_bbox
        if w > 0 and h > 0:
            cv2.imwrite(str(out / "approach_lie_footer.png"), initial[y:y+h, x:x+w])
        _save_card(out / "approach_pin_card.png", initial, pin_state)
        _save_card(out / "approach_aim_card.png", aim_screen, aim_state)
        persist_ms = round((time.perf_counter() - t0) * 1000.0, 1)

        print()
        print("GSPro POST-TEE SHOT STATE PROBE v1")
        print("=================================")
        print("W zoom:                NOT USED (decision only)")
        print("Y heatmap:             NOT USED")
        print(f"Pin target:            {pin_state.distance_yds:.0f} yd")
        print(f"Pin elevation:         {pin_state.elevation_direction} {pin_state.elevation_raw or '?'}")
        print(f"Lie slope:             {lie_state.state_text(lie)}")
        if aim_state is not None:
            print(f"GSPro aim target:      {aim_state.distance_yds:.0f} yd | {aim_state.elevation_direction} {aim_state.elevation_raw or '?'}")
        else:
            print("GSPro aim target:      unavailable")
        print(f"AIM acquisition:       {aim_meta.get('status')}")
        if aim_meta.get("verified_return") is not None:
            print(f"Aim return verified:   {aim_meta.get('verified_return')}")

        if geometry is not None:
            reg = geometry["registration"]
            pos = geometry["canonical_position"]
            chk = geometry["pin_distance_crosscheck"]
            gv = geometry["green_visibility"]
            print(f"Map registration:      {reg['confidence']:.2f} confidence | {reg['inliers']} inliers")
            print(
                f"Canonical position:    {pos['tee_relative_forward_yds']:.0f} yd forward | "
                f"{pos['tee_relative_lateral_yds']:+.0f} yd lateral"
            )
            print(
                f"Pin cross-check:       {chk['canonical_remaining_pin_yds']:.1f} yd canonical "
                f"vs {chk['screen_pin_distance_yds']:.1f} yd screen | {'PASS' if chk['ok'] else 'WARN'}"
            )
            print(f"Target green visible:  {'YES' if gv['visible'] else 'NO'}")
            print(f"W recovery decision:   {'WOULD ZOOM OUT' if geometry['w_recovery_recommended'] else 'NOT NEEDED'}")
        else:
            print("Canonical geometry:    unavailable")
            print(f"Geometry warning:      {geometry_warning}")

        print()
        print("Performance timing")
        print("------------------")
        for key, label in (
            ("initial_capture", "Initial capture"),
            ("pin_card_ocr", "PIN card OCR*"),
            ("lie_ocr", "Lie OCR*"),
            ("aim_acquisition", "AIM acquisition"),
            ("canonical_geometry", "Canonical geometry"),
        ):
            if key in timer.phase_ms:
                print(f"{label + ':':24} {timer.phase_ms[key]:7.1f} ms")
        print("* OCR runs overlapped with AIM acquisition")
        print(f"{'STATE READY:':24} {state_ready_ms:7.1f} ms")
        print(f"{'Review persistence:':24} {persist_ms:7.1f} ms")

        print()
        print(f"ShotState:             {out / 'shot_state.json'}")
        print(f"As-presented minimap:  {out / 'approach_minimap.png'}")
        print(f"Capture folder:        {out}")
        return 0

    except Exception as exc:
        try:
            (out / "approach_capture_meta.json").write_text(
                json.dumps({
                    "success": False,
                    "error": str(exc),
                    "elapsed_ms": timer.elapsed_ms(),
                    "phase_ms": timer.phase_ms,
                }, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass
        print(f"ERROR: {exc}", file=sys.stderr)
        print(f"Debug folder: {out}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
