from __future__ import annotations
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from .assumptions import Assumptions

MINIMAP_PROBE_DIR = Path(__file__).resolve().parents[1] / "minimap_probe"
if str(MINIMAP_PROBE_DIR) not in sys.path:
    sys.path.insert(0, str(MINIMAP_PROBE_DIR))
import probe as minimap_probe  # noqa: E402


def _axis(hole_model: dict):
    minimap = hole_model["minimap"]
    ball = np.array([
        float(minimap["ball_pixel"]["x"]),
        float(minimap["ball_pixel"]["y"]),
    ], dtype=float)
    pin = np.array([
        float(minimap["pin_pixel"]["x"]),
        float(minimap["pin_pixel"]["y"]),
    ], dtype=float)
    scale = float(minimap["yards_per_pixel"])
    vector = pin - ball
    length = float(np.linalg.norm(vector))
    if length < 10 or scale <= 0:
        raise ValueError("invalid tee HoleModel axis/scale")
    forward = vector / length
    right = np.array([-forward[1], forward[0]], dtype=float)
    return ball, pin, forward, right, scale


def _to_yards(x: float, y: float, ball, forward, right, scale: float) -> dict:
    delta = np.array([float(x), float(y)], dtype=float) - ball
    return {
        "forward": float(np.dot(delta, forward) * scale),
        "right": float(np.dot(delta, right) * scale),
    }


def _hazard_boundaries(image, hole_model: dict, assumptions: Assumptions) -> list[dict]:
    ball, _pin, forward, right, scale = _axis(hole_model)
    config = assumptions.get("canonical_geometry")
    mask = minimap_probe.penalty_mask(image)
    cv2.circle(
        mask,
        (
            round(float(hole_model["minimap"]["ball_pixel"]["x"])),
            round(float(hole_model["minimap"]["ball_pixel"]["y"])),
        ),
        int(config["player_marker_mask_radius_px"]),
        0,
        -1,
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    boundaries = []
    next_id = 1
    for contour in contours:
        arc = float(cv2.arcLength(contour, False))
        if arc < float(config["hazard_min_arc_length_px"]):
            continue
        simplified = cv2.approxPolyDP(
            contour,
            float(config["hazard_simplify_epsilon_px"]),
            False,
        )
        points = [
            _to_yards(float(point[0][0]), float(point[0][1]), ball, forward, right, scale)
            for point in simplified
        ]
        if len(points) < 2:
            continue
        boundaries.append({
            "hazard_id": f"penalty-{next_id}",
            "points": points,
            "source": "gspro-red-penalty-boundary",
            "side_semantics_known": False,
            "source_arc_length_px": arc,
        })
        next_id += 1
    return boundaries


def _green_surface(mask, heatmap, hole_model: dict, assumptions: Assumptions) -> dict:
    ball, pin_pixel, forward, right, scale = _axis(hole_model)
    config = assumptions.get("canonical_geometry")
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise RuntimeError("target green mask had no contour")
    contour = max(contours, key=cv2.contourArea)
    simplified = cv2.approxPolyDP(
        contour,
        float(config["green_simplify_epsilon_px"]),
        True,
    )
    polygon = [
        _to_yards(float(point[0][0]), float(point[0][1]), ball, forward, right, scale)
        for point in simplified
    ]

    hsv = cv2.cvtColor(heatmap, cv2.COLOR_BGR2HSV)
    ys, xs = np.where(mask > 0)
    stride = max(1, int(config["heatmap_sample_stride_px"]))
    samples = []
    for index in range(0, len(xs), stride):
        x, y = int(xs[index]), int(ys[index])
        h, s, v = [int(value) for value in hsv[y, x]]
        sample = _to_yards(x, y, ball, forward, right, scale)
        sample["hsv"] = [h, s, v]
        samples.append(sample)

    return {
        "polygon": polygon,
        "pin": _to_yards(float(pin_pixel[0]), float(pin_pixel[1]), ball, forward, right, scale),
        "heatmap_samples": samples,
        "confidence": float((hole_model.get("green_surface") or {}).get("heatmap_confidence") or 0.0),
        "source": "gspro-tee-heatmap",
        "raw_heatmap_semantics": "HSV samples preserved; no slope meaning inferred here",
    }


def build_canonical_hole(capture_dir: str | Path, assumptions: Assumptions | None = None) -> dict:
    assumptions = assumptions or Assumptions.load()
    capture = Path(capture_dir)
    hole_model = json.loads((capture / "hole_model.json").read_text(encoding="utf-8"))
    hazard_image = cv2.imread(str(capture / "tee_hazard_safe_minimap.png"), cv2.IMREAD_COLOR)
    green_mask = cv2.imread(str(capture / "tee_target_green_mask.png"), cv2.IMREAD_GRAYSCALE)
    heatmap = cv2.imread(str(capture / "tee_heatmap_minimap.png"), cv2.IMREAD_COLOR)
    if hazard_image is None or green_mask is None or heatmap is None:
        raise RuntimeError("capture folder is missing tee hazard/green/heatmap review artifacts")

    ball, pin, _forward, _right, scale = _axis(hole_model)
    payload = {
        "schema_version": "canonical-hole-model-v0",
        "assumption_version": assumptions.version,
        "coordinate_system": {
            "origin": "tee ball",
            "forward_axis": "tee-to-pin",
            "right_positive": True,
            "yards_per_source_pixel": scale,
            "tee_source_pixel": {"x": float(ball[0]), "y": float(ball[1])},
            "pin_source_pixel": {"x": float(pin[0]), "y": float(pin[1])},
        },
        "hazards": _hazard_boundaries(hazard_image, hole_model, assumptions),
        "green_surface": _green_surface(green_mask, heatmap, hole_model, assumptions),
        "source_hole_model": str(capture / "hole_model.json"),
    }
    (capture / "canonical_hole_model.json").write_text(
        json.dumps(payload, indent=2),
        encoding="utf-8",
    )
    return payload


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(
        description="Build canonical yard-space HoleModel from a tee capture folder"
    )
    parser.add_argument("capture_dir")
    args = parser.parse_args()
    payload = build_canonical_hole(args.capture_dir)
    print(f"Canonical hazards: {len(payload['hazards'])}")
    print(f"Green polygon points: {len(payload['green_surface']['polygon'])}")
    print(Path(args.capture_dir) / "canonical_hole_model.json")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
