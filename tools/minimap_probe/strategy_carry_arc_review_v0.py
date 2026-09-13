#!/usr/bin/env python3
"""Package carry-arc strategy outputs into one self-contained review ZIP."""
from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import shutil
import zipfile

import cv2
import numpy as np

import strategy_carry_arc_v0 as arc

SCHEMA_VERSION = "looper-strategy-carry-arc-review-v0"


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _panel(image: np.ndarray, title: str, subtitle: str, width: int = 340) -> np.ndarray:
    h, w = image.shape[:2]
    target_h = max(1, round(h * width / w))
    body = cv2.resize(image, (width, target_h), interpolation=cv2.INTER_AREA)
    header = np.zeros((58, width, 3), dtype=np.uint8)
    header[:] = (18, 24, 20)
    cv2.putText(header, title, (9, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (245,245,245), 1, cv2.LINE_AA)
    cv2.putText(header, subtitle[:58], (9, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (185,205,190), 1, cv2.LINE_AA)
    return np.vstack([header, body])


def _copy_if_present(src: Path, dst: Path, name: str) -> bool:
    p = src / name
    if not p.is_file():
        return False
    shutil.copy2(p, dst / name)
    return True


def build(capture_root: Path, *, latest: int = 18, preferred_carry: int = 230) -> tuple[Path, Path]:
    captures = arc.capture_dirs([str(capture_root)])
    if latest > 0:
        captures = captures[-latest:]
    rows = []
    for capture in captures:
        agg = capture / "strategy_carry_arc_v0.json"
        if not agg.is_file():
            continue
        payload = _read(agg)
        hole = int((payload.get("identity") or {}).get("hole_display") or 999)
        rows.append((hole, capture, payload))
    if not rows:
        raise RuntimeError("No strategy_carry_arc_v0 outputs found")
    rows.sort(key=lambda x: x[0])

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    review_dir = capture_root / f"strategy_carry_arc_review_{stamp}"
    review_dir.mkdir(parents=True, exist_ok=False)
    panels = []
    manifest_rows = []

    for hole, capture, payload in rows:
        hole_dir = review_dir / f"hole_{hole:02d}"
        hole_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(capture / "strategy_carry_arc_v0.json", hole_dir / "strategy_carry_arc_v0.json")

        carry_rows = []
        for summary in payload.get("carry_results") or []:
            carry = int(round(float(summary["carry_yds"])))
            names = [
                f"strategy_carry_arc_{carry:04d}_v0.json",
                f"strategy_carry_arc_{carry:04d}_prompt_v0.png",
                f"strategy_carry_arc_{carry:04d}_overlay_v0.png",
            ]
            copied = []
            for name in names:
                if _copy_if_present(capture, hole_dir, name):
                    copied.append(name)
            detail = _read(capture / names[0]) if (capture / names[0]).is_file() else {}
            accepted = int(detail.get("accepted_span_count") or 0)
            carry_rows.append({"carry_yds": carry, "accepted_span_count": accepted, "artifacts": copied})

        context = []
        for name in (
            "screenshot_strategy_geometry_v2.json",
            "screenshot_strategy_geometry_overlay_v2.png",
            "hole_model.json",
            "capture_context.json",
            "bunker_recall_v1.json",
            "red_penalty_pixel_geometry_v1.json",
            "white_boundary_pixel_geometry_v1.json",
            "tee_hazard_safe_minimap.png",
            "tee_canonical_minimap.png",
            "tee_initial_minimap.png",
        ):
            if _copy_if_present(capture, hole_dir, name):
                context.append(name)

        preferred = next((r for r in carry_rows if r["carry_yds"] == preferred_carry), None)
        if preferred is None and carry_rows:
            preferred = min(carry_rows, key=lambda r: abs(r["carry_yds"] - preferred_carry))
        if preferred:
            overlay = capture / f"strategy_carry_arc_{preferred['carry_yds']:04d}_overlay_v0.png"
            if overlay.is_file():
                image = cv2.imread(str(overlay), cv2.IMREAD_COLOR)
                if image is not None:
                    summary_text = ", ".join(f"{r['carry_yds']}:{r['accepted_span_count']}" for r in carry_rows)
                    panels.append(_panel(image, f"H{hole} carry-arc", summary_text))

        manifest_rows.append({
            "hole": hole,
            "capture": capture.name,
            "par": (payload.get("identity") or {}).get("par"),
            "hole_yards": (payload.get("identity") or {}).get("hole_yards"),
            "carry_results": carry_rows,
            "included_strategy_context": context,
        })

    if panels:
        cols = 3
        gap = 12
        cw = max(p.shape[1] for p in panels)
        ch = max(p.shape[0] for p in panels)
        rows_n = (len(panels) + cols - 1) // cols
        sheet = np.zeros((rows_n * ch + (rows_n - 1) * gap, cols * cw + (cols - 1) * gap, 3), dtype=np.uint8)
        sheet[:] = (8, 12, 10)
        for i, panel in enumerate(panels):
            y = (i // cols) * (ch + gap)
            x = (i % cols) * (cw + gap)
            sheet[y:y+panel.shape[0], x:x+panel.shape[1]] = panel
        cv2.imwrite(str(review_dir / "strategy_carry_arc_contact_sheet_v0.jpg"), sheet, [int(cv2.IMWRITE_JPEG_QUALITY), 91])

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "primitive": "club-carry radius arc intersected with current-hole fairway",
        "rows": manifest_rows,
        "strategy_authority": False,
        "promotion": "none",
    }
    (review_dir / "strategy_carry_arc_review_v0.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    zip_path = review_dir.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for p in review_dir.rglob("*"):
            if p.is_file():
                archive.write(p, p.relative_to(review_dir.parent))
    return review_dir, zip_path


def main() -> int:
    p = argparse.ArgumentParser(description="Package Carry Arc v0 outputs into one ZIP")
    p.add_argument("--capture-root", default="tools/minimap_probe/output")
    p.add_argument("--latest", type=int, default=18)
    p.add_argument("--preferred-carry", type=int, default=230)
    args = p.parse_args()
    review, zip_path = build(Path(args.capture_root).expanduser().resolve(), latest=args.latest, preferred_carry=args.preferred_carry)
    print(f"Review folder: {review}")
    print(f"Review ZIP: {zip_path}")
    print(f"UPLOAD THIS ONE FILE: {zip_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
