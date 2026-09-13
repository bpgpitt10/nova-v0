#!/usr/bin/env python3
"""Package the broader carry-arc validation batch into one self-contained ZIP."""
from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import shutil
import zipfile

import cv2
import numpy as np

import strategy_carry_arc_v0 as arc0
import strategy_carry_arc_v1 as arc1

SCHEMA_VERSION = "looper-strategy-parallel-review-v1"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def copy_if(src: Path, dst: Path, name: str) -> bool:
    path = src / name
    if not path.is_file():
        return False
    shutil.copy2(path, dst / name)
    return True


def panel(image: np.ndarray, title: str, subtitle: str, width: int = 350) -> np.ndarray:
    h, w = image.shape[:2]
    target_h = max(1, round(h * width / w))
    body = cv2.resize(image, (width, target_h), interpolation=cv2.INTER_AREA)
    head = np.zeros((58, width, 3), dtype=np.uint8)
    head[:] = (18,24,20)
    cv2.putText(head, title[:48], (8,21), cv2.FONT_HERSHEY_SIMPLEX, 0.51, (245,245,245), 1, cv2.LINE_AA)
    cv2.putText(head, subtitle[:60], (8,45), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (185,205,190), 1, cv2.LINE_AA)
    return np.vstack([head, body])


def build(capture_root: Path, *, latest: int = 18, baseline_carry: int = 220) -> tuple[Path, Path]:
    captures = arc0.capture_dirs([str(capture_root)])
    if latest > 0:
        captures = captures[-latest:]
    rows = []
    for capture in captures:
        agg = capture / "strategy_carry_arc_v1.json"
        if not agg.is_file():
            continue
        payload = read_json(agg)
        hole = int((payload.get("identity") or {}).get("hole_display") or 999)
        rows.append((hole, capture, payload))
    if not rows:
        raise RuntimeError("No strategy_carry_arc_v1 outputs found")
    rows.sort(key=lambda x: x[0])

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    review_dir = capture_root / f"strategy_parallel_review_{stamp}"
    review_dir.mkdir(parents=True, exist_ok=False)

    profile_path = arc1.discover_course_profile(capture_root)
    profile_manifest = None
    if profile_path and profile_path.is_file():
        profile_dir = review_dir / "course_profile"
        profile_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(profile_path, profile_dir / "course_visual_profile_v0.json")
        sheet = profile_path.parent / "course_visual_profile_contact_sheet_v0.jpg"
        if sheet.is_file():
            shutil.copy2(sheet, profile_dir / sheet.name)
        try:
            profile_manifest = read_json(profile_path)
        except Exception:
            profile_manifest = None

    panels = []
    manifest_rows = []
    for hole, capture, aggregate in rows:
        hole_dir = review_dir / f"hole_{hole:02d}"
        hole_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(capture / "strategy_carry_arc_v1.json", hole_dir / "strategy_carry_arc_v1.json")

        carry_rows = []
        for item in aggregate.get("carry_results") or []:
            carry = int(round(float(item["carry_yds"])))
            detail_name = f"strategy_carry_arc_{carry:04d}_v1.json"
            detail_path = capture / detail_name
            detail = read_json(detail_path) if detail_path.is_file() else {}
            files = []
            for name in (
                detail_name,
                f"strategy_carry_arc_{carry:04d}_prompt_v1.png",
                f"strategy_carry_arc_{carry:04d}_overlay_v1.png",
            ):
                if copy_if(capture, hole_dir, name):
                    files.append(name)
            carry_rows.append({
                "carry_yds": carry,
                "accepted_span_count": int(detail.get("accepted_span_count") or 0),
                "semantic_present": detail.get("semantic_present"),
                "qa_warnings": (detail.get("qa") or {}).get("warnings") or [],
                "artifacts": files,
            })

        baseline = None
        baseline_name = f"strategy_carry_arc_{baseline_carry:04d}_v0.json"
        if (capture / baseline_name).is_file():
            raw = read_json(capture / baseline_name)
            baseline = {
                "carry_yds": baseline_carry,
                "accepted_span_count": int(raw.get("accepted_span_count") or 0),
                "semantic_present": raw.get("semantic_present"),
            }
            for name in (
                baseline_name,
                f"strategy_carry_arc_{baseline_carry:04d}_prompt_v0.png",
                f"strategy_carry_arc_{baseline_carry:04d}_overlay_v0.png",
            ):
                copy_if(capture, hole_dir, name)

        route = None
        route_path = capture / "strategy_carry_route_shadow_v0.json"
        if route_path.is_file():
            route = read_json(route_path)
            shutil.copy2(route_path, hole_dir / route_path.name)
            copy_if(capture, hole_dir, "strategy_carry_route_shadow_v0.png")

        context = []
        for name in (
            "screenshot_strategy_geometry_v2.json",
            "screenshot_strategy_geometry_overlay_v2.png",
            "hole_spatial_model_v1.json",
            "hole_model.json",
            "capture_context.json",
            "bunker_recall_v1.json",
            "red_penalty_pixel_geometry_v1.json",
            "white_boundary_pixel_geometry_v1.json",
            "tee_hazard_safe_minimap.png",
            "tee_canonical_minimap.png",
            "tee_initial_minimap.png",
        ):
            if copy_if(capture, hole_dir, name):
                context.append(name)

        preferred_image = capture / "strategy_carry_route_shadow_v0.png"
        if not preferred_image.is_file():
            preferred = min(carry_rows, key=lambda r: abs(r["carry_yds"] - baseline_carry)) if carry_rows else None
            preferred_image = capture / f"strategy_carry_arc_{preferred['carry_yds']:04d}_overlay_v1.png" if preferred else Path("__missing__")
        if preferred_image.is_file():
            image = cv2.imread(str(preferred_image), cv2.IMREAD_COLOR)
            if image is not None:
                counts = ",".join(f"{row['carry_yds']}:{row['accepted_span_count']}" for row in carry_rows)
                base_text = "n/a" if baseline is None else str(baseline["accepted_span_count"])
                route_text = "Y" if route and route.get("available") else "N"
                panels.append(panel(image, f"H{hole} route={route_text}  baseline{baseline_carry}={base_text}", counts))

        v1_baseline_row = next((r for r in carry_rows if r["carry_yds"] == baseline_carry), None)
        manifest_rows.append({
            "hole": hole,
            "capture": capture.name,
            "par": (aggregate.get("identity") or {}).get("par"),
            "hole_yards": (aggregate.get("identity") or {}).get("hole_yards"),
            "course_visual_profile_used": (aggregate.get("course_visual_profile") or {}).get("used"),
            "carry_results_v1": carry_rows,
            "baseline_v0": baseline,
            "baseline_comparison": {
                "carry_yds": baseline_carry,
                "v0_accepted_span_count": None if baseline is None else baseline["accepted_span_count"],
                "v1_accepted_span_count": None if v1_baseline_row is None else v1_baseline_row["accepted_span_count"],
            },
            "route_available": bool(route and route.get("available")),
            "route_warnings": [] if not route else route.get("warnings") or [],
            "included_context": context,
        })

    contact_name = None
    if panels:
        cols = 3
        gap = 12
        cw = max(p.shape[1] for p in panels)
        ch = max(p.shape[0] for p in panels)
        rows_n = (len(panels) + cols - 1) // cols
        sheet = np.zeros((rows_n * ch + (rows_n - 1) * gap, cols * cw + (cols - 1) * gap, 3), dtype=np.uint8)
        sheet[:] = (8,12,10)
        for i, p in enumerate(panels):
            y = (i // cols) * (ch + gap)
            x = (i % cols) * (cw + gap)
            sheet[y:y+p.shape[0], x:x+p.shape[1]] = p
        contact_name = "strategy_parallel_contact_sheet_v1.jpg"
        cv2.imwrite(str(review_dir / contact_name), sheet, [int(cv2.IMWRITE_JPEG_QUALITY), 91])

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "purpose": "single-upload validation of course visual prior + carry arcs + old-prompt control + cross-carry route + existing hazards",
        "course_profile": None if profile_manifest is None else {
            "course_identity": profile_manifest.get("course_identity"),
            "evidence": profile_manifest.get("evidence"),
            "policy": profile_manifest.get("policy"),
        },
        "baseline_carry_yds": baseline_carry,
        "rows": manifest_rows,
        "contact_sheet": contact_name,
        "strategy_authority": False,
        "promotion": "none",
    }
    (review_dir / "strategy_parallel_review_v1.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    zip_path = review_dir.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in review_dir.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(review_dir.parent))
    return review_dir, zip_path


def main() -> int:
    p = argparse.ArgumentParser(description="Package parallel strategy validation into one ZIP")
    p.add_argument("--capture-root", default="tools/minimap_probe/output")
    p.add_argument("--latest", type=int, default=18)
    p.add_argument("--baseline-carry", type=int, default=220)
    args = p.parse_args()
    review, zip_path = build(Path(args.capture_root).expanduser().resolve(), latest=args.latest, baseline_carry=args.baseline_carry)
    print(f"Review folder: {review}")
    print(f"Review ZIP: {zip_path}")
    print(f"UPLOAD THIS ONE FILE: {zip_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
