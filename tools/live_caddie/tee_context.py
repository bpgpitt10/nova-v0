from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import sys

import cv2
import numpy as np

from .assumptions import Assumptions

MINIMAP_DIR = Path(__file__).resolve().parents[1] / "minimap_probe"
if str(MINIMAP_DIR) not in sys.path:
    sys.path.insert(0, str(MINIMAP_DIR))

import aim_marker  # noqa: E402
import probe as minimap_probe  # noqa: E402


def _axis(hole_model: dict) -> tuple[np.ndarray, np.ndarray, float]:
    minimap = hole_model.get("minimap") or {}
    ball = minimap.get("ball_pixel") or {}
    pin = minimap.get("pin_pixel") or {}
    tee = np.array([float(ball["x"]), float(ball["y"])], dtype=float)
    target = np.array([float(pin["x"]), float(pin["y"])], dtype=float)
    scale = float(minimap.get("yards_per_pixel") or 0.0)
    if scale <= 0 or float(np.linalg.norm(target - tee)) < 10:
        raise ValueError("tee HoleModel has invalid ball/pin axis or scale")
    return tee, target, scale


def _tee_relative(tee: np.ndarray, pin: np.ndarray, scale: float, x: float, y: float) -> tuple[float, float]:
    axis = pin - tee
    unit = axis / float(np.linalg.norm(axis))
    right = np.array([-unit[1], unit[0]], dtype=float)
    delta = np.array([float(x), float(y)], dtype=float) - tee
    return float(np.dot(delta, unit) * scale), float(np.dot(delta, right) * scale)


def build_tee_context(capture_dir: str | Path, assumptions: Assumptions | None = None) -> dict:
    """Recover tee GSPro strategic AIM geometry without changing proven tee capture.

    This is post-processing only. It reads the already-restored tee screenshot and
    AIM-card distance, finds the gray AIM marker, and expresses that target in the
    tee HoleModel's canonical yard coordinates. It never sends a GSPro key.
    """
    assumptions = assumptions or Assumptions.load()
    capture = Path(capture_dir)
    hole_model = json.loads((capture / "hole_model.json").read_text(encoding="utf-8"))
    shot_state = json.loads((capture / "shot_state.json").read_text(encoding="utf-8"))
    restored_path = capture / "tee_restored_screen.png"
    screen = cv2.imread(str(restored_path), cv2.IMREAD_COLOR)
    if screen is None:
        raise RuntimeError(f"missing restored tee screen: {restored_path}")

    aim = shot_state.get("aim") or {}
    aim_distance = aim.get("distance_yds")
    if aim_distance is None:
        raise RuntimeError("tee ShotState has no AIM-card distance")

    minimap, bbox = minimap_probe.crop_minimap(screen, None)
    tee, pin, scale = _axis(hole_model)
    marker = aim_marker.detect_aim_marker(
        minimap,
        ball_xy=(float(tee[0]), float(tee[1])),
        pin_xy=(float(pin[0]), float(pin[1])),
        pin_distance_yds=float((shot_state.get("pin") or {}).get("distance_yds") or math.dist(tee, pin) * scale),
        aim_distance_yds=float(aim_distance),
        detector_config=assumptions.get("screen_detection.aim_marker"),
    )
    forward, right = _tee_relative(tee, pin, scale, marker.x, marker.y)

    payload = {
        "schema_version": "tee-live-context-v0",
        "assumption_version": assumptions.version,
        "capture_dir": str(capture),
        "minimap_bbox": list(bbox),
        "aim_context": {
            "forward_yds": forward,
            "right_yds": right,
            "distance_yds": float(aim_distance),
            "elevation_delta_yds": float(aim.get("elevation_delta_yds") or 0.0),
            "marker": marker.to_dict(),
            "source": "restored-tee-minimap-gray-aim-marker+aim-card",
        },
    }
    (capture / "tee_live_context.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Recover canonical GSPro strategic AIM from a saved tee capture")
    parser.add_argument("capture_dir")
    args = parser.parse_args()
    payload = build_tee_context(args.capture_dir)
    aim = payload["aim_context"]
    print(f"Tee strategic AIM: {aim['forward_yds']:.1f} yd forward | {aim['right_yds']:+.1f} yd right")
    print(f"AIM checksum error: {aim['marker']['distance_error_yds']:.1f} yd")
    print(Path(args.capture_dir) / "tee_live_context.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
