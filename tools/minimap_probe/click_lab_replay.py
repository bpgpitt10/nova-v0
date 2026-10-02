#!/usr/bin/env python3
"""Offline Click Lab replay from a previously captured GSPro screenshot.

No GSPro process or mouse control is required. This is useful for validating marker
recognition, scale, handedness and predicted click location from screenshots while
away from the simulator.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2

import click_lab
import probe as base
import probe_v2 as v2


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Replay Click Lab against a static GSPro screenshot")
    p.add_argument("--image", required=True, help="Path to a GSPro screenshot")
    p.add_argument("--distance", type=float, required=True, help="Known distance to pin in yards")
    p.add_argument("--right", type=float, required=True, help="Target yards right (+) / left (-)")
    p.add_argument("--forward", type=float, required=True, help="Target yards forward from ball")
    p.add_argument("--roi", help="Optional minimap ROI x,y,w,h")
    p.add_argument("--output", help="Output annotated PNG path")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    image_path = Path(args.image)
    screen = cv2.imread(str(image_path))
    if screen is None:
        raise RuntimeError(f"Could not read screenshot: {image_path}")

    roi, roi_box = base.crop_minimap(screen, args.roi)
    ball = v2.detect_ball_marker(roi)
    pin = v2.detect_pin_marker(roi)
    predicted, scale = click_lab.predict_minimap_pixel(
        ball,
        pin,
        float(args.distance),
        float(args.right),
        float(args.forward),
    )
    expected = (float(args.right) ** 2 + float(args.forward) ** 2) ** 0.5
    annotated = click_lab.annotate_preview(screen, roi_box, ball, pin, predicted, expected)

    output = Path(args.output) if args.output else image_path.with_name(f"{image_path.stem}_click_lab.png")
    cv2.imwrite(str(output), annotated)

    print("Click Lab screenshot replay PASS")
    print(f"  image:            {image_path}")
    print(f"  scale:            {scale:.4f} yd/px")
    print(f"  ball ROI pixel:   ({ball.x:.1f}, {ball.y:.1f})")
    print(f"  pin ROI pixel:    ({pin.x:.1f}, {pin.y:.1f})")
    print(f"  target ROI pixel: ({predicted.x:.1f}, {predicted.y:.1f})")
    print(f"  annotated:        {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
