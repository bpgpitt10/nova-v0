#!/usr/bin/env python3
"""Package Fairway Corridor v1 outputs into one visual review ZIP."""
from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import shutil
import zipfile

import cv2
import numpy as np

import fairway_corridor_v1 as corridor

SCHEMA_VERSION = "looper-fairway-corridor-review-v1"


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _panel(image: np.ndarray, title: str, subtitle: str, width: int = 360) -> np.ndarray:
    h, w = image.shape[:2]
    target_h = max(1, round(h * width / w))
    body = cv2.resize(image, (width, target_h), interpolation=cv2.INTER_AREA)
    header = np.zeros((58, width, 3), dtype=np.uint8)
    header[:] = (18, 24, 20)
    cv2.putText(header, title, (9, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.53, (245, 245, 245), 1, cv2.LINE_AA)
    cv2.putText(header, subtitle[:58], (9, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.39, (185, 205, 190), 1, cv2.LINE_AA)
    return np.vstack([header, body])


def build(capture_root: Path, *, latest: int = 18) -> tuple[Path, Path]:
    captures = corridor.capture_dirs([str(capture_root)])
    if latest > 0:
        captures = captures[-latest:]
    rows = []
    for capture in captures:
        payload_path = capture / "fairway_corridor_v1.json"
        if not payload_path.is_file():
            continue
        payload = _read(payload_path)
        ident = payload.get("identity") or {}
        overlay_name = payload.get("overlay_artifact") or "fairway_corridor_overlay_v1.png"
        overlay = capture / overlay_name
        if not overlay.is_file():
            continue
        rows.append((int(ident.get("hole_display") or 999), capture, payload, overlay))
    if not rows:
        raise RuntimeError("No fairway_corridor_v1 outputs found for review")
    rows.sort(key=lambda item: item[0])

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    review_dir = capture_root / f"fairway_corridor_review_{stamp}"
    review_dir.mkdir(parents=True, exist_ok=False)

    panels = []
    manifest_rows = []
    for hole, capture, payload, overlay_path in rows:
        image = cv2.imread(str(overlay_path), cv2.IMREAD_COLOR)
        if image is None:
            continue
        accepted = int(payload.get("accepted_station_count") or 0)
        requested = int(payload.get("requested_station_count") or 0)
        widths = [float(row["width_yds"]) for row in payload.get("stations") or [] if row.get("accepted") and row.get("width_yds") is not None]
        width_text = "n/a" if not widths else f"{min(widths):.0f}-{max(widths):.0f} yd"
        warning_count = sum(len(row.get("warnings") or []) for row in payload.get("stations") or [])
        panels.append(_panel(image, f"H{hole}  corridor {accepted}/{requested}", f"widths {width_text} | warnings {warning_count}"))

        hole_dir = review_dir / f"hole_{hole:02d}"
        hole_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(overlay_path, hole_dir / "fairway_corridor_overlay_v1.png")
        shutil.copy2(capture / "fairway_corridor_v1.json", hole_dir / "fairway_corridor_v1.json")
        prompt = capture / "fairway_corridor_prompt_v1.png"
        if prompt.is_file():
            shutil.copy2(prompt, hole_dir / "fairway_corridor_prompt_v1.png")
        manifest_rows.append({
            "hole": hole,
            "capture": capture.name,
            "accepted_stations": accepted,
            "requested_stations": requested,
            "minimum_width_yds": min(widths) if widths else None,
            "maximum_width_yds": max(widths) if widths else None,
            "station_warning_count": warning_count,
        })

    cols = 3
    gap = 12
    cell_w = max(panel.shape[1] for panel in panels)
    cell_h = max(panel.shape[0] for panel in panels)
    rows_n = (len(panels) + cols - 1) // cols
    sheet = np.zeros((rows_n * cell_h + (rows_n - 1) * gap, cols * cell_w + (cols - 1) * gap, 3), dtype=np.uint8)
    sheet[:] = (8, 12, 10)
    for index, panel in enumerate(panels):
        row = index // cols
        col = index % cols
        y = row * (cell_h + gap)
        x = col * (cell_w + gap)
        sheet[y:y + panel.shape[0], x:x + panel.shape[1]] = panel
    contact_name = "fairway_corridor_contact_sheet_v1.jpg"
    cv2.imwrite(str(review_dir / contact_name), sheet, [int(cv2.IMWRITE_JPEG_QUALITY), 91])

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "rows": manifest_rows,
        "contact_sheet": contact_name,
        "strategy_authority": False,
        "promotion": "none",
    }
    (review_dir / "fairway_corridor_review_v1.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    zip_path = review_dir.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in review_dir.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(review_dir.parent))
    return review_dir, zip_path


def main() -> int:
    p = argparse.ArgumentParser(description="Create Fairway Corridor v1 review ZIP")
    p.add_argument("--capture-root", default="tools/minimap_probe/output")
    p.add_argument("--latest", type=int, default=18)
    args = p.parse_args()
    review, zip_path = build(Path(args.capture_root).expanduser().resolve(), latest=args.latest)
    print(f"Review folder: {review}")
    print(f"Review ZIP: {zip_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
