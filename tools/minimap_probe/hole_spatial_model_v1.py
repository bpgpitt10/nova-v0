#!/usr/bin/env python3
"""Build/watch tee spatial models in GSPro world + hole-local coordinates.

Passive/fail-soft. Joins tee/pin minimap anchors from hole_model.json to the
matching GSPro course-layout teePos/pinPos pair from output_log.txt, then projects
canonical tee hazards into hole-local yards and GSPro X/Z. No GSPro input.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import time
from typing import Any

YARDS_PER_WORLD_UNIT = 1.0936132983377078
SCHEMA_VERSION = "looper-hole-spatial-model-v1"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    tmp.replace(path)


def norm(x: float, y: float) -> tuple[float, float]:
    d = math.hypot(x, y)
    if d <= 1e-9:
        raise ValueError("zero-length anchor vector")
    return x / d, y / d


def course_layout_arrays(text: str) -> list[list[dict[str, Any]]]:
    decoder = json.JSONDecoder()
    out = []
    start = 0
    while True:
        pos = text.find('[{"active"', start)
        if pos < 0:
            return out
        try:
            value, used = decoder.raw_decode(text[pos:])
        except Exception:
            start = pos + 2
            continue
        start = pos + max(used, 2)
        if not isinstance(value, list) or len(value) < 9:
            continue
        rows = [r for r in value if isinstance(r, dict) and isinstance(r.get("teePos"), dict) and isinstance(r.get("pinPos"), dict)]
        if len(rows) >= 9:
            out.append(rows)


def world_distance_3d_yds(row: dict[str, Any]) -> float:
    tee, pin = row["teePos"], row["pinPos"]
    dx = float(pin["x"]) - float(tee["x"])
    dy = float(pin.get("y", 0.0)) - float(tee.get("y", 0.0))
    dz = float(pin["z"]) - float(tee["z"])
    return math.sqrt(dx * dx + dy * dy + dz * dz) * YARDS_PER_WORLD_UNIT


def select_layout_row(rows: list[dict[str, Any]], pin_yds: float, par: int | None, hole_display: int | None):
    # GSPro course-layout rows are emitted in displayed round order. strokeIdx is
    # the underlying course-hole identity and may be non-sequential.
    if hole_display is not None and 1 <= int(hole_display) <= len(rows):
        row = rows[int(hole_display) - 1]
        dist = world_distance_3d_yds(row)
        error = abs(dist - pin_yds)
        par_match = par is None or int(row.get("par") or -999) == int(par)
        if error <= 4.0 and par_match:
            return row, {
                "binding": "display-hole-array-order",
                "hole_display": int(hole_display),
                "pin_distance_yds": pin_yds,
                "matched_world_3d_distance_yds": dist,
                "distance_error_yds": error,
                "par_match": True,
                "stroke_idx": row.get("strokeIdx"),
            }

    scored = []
    for row in rows:
        dist = world_distance_3d_yds(row)
        par_match = par is None or int(row.get("par") or -999) == int(par)
        error = abs(dist - pin_yds)
        scored.append((error + (0.0 if par_match else 100.0), error, par_match, row, dist))
    scored.sort(key=lambda x: x[0])
    if not scored or scored[0][1] > 4.0:
        raise RuntimeError("no course-layout tee/pin pair matches tee PIN distance")
    if len(scored) > 1 and scored[1][0] - scored[0][0] < 1.0:
        raise RuntimeError("ambiguous fallback tee/pin match")
    best = scored[0]
    return best[3], {
        "binding": "distance-par-fallback",
        "hole_display": hole_display,
        "pin_distance_yds": pin_yds,
        "matched_world_3d_distance_yds": best[4],
        "distance_error_yds": best[1],
        "par_match": bool(best[2]),
        "stroke_idx": best[3].get("strokeIdx"),
    }


def anchor_transform(hole_model: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    mm = hole_model.get("minimap") or {}
    tee_px, pin_px = mm.get("ball_pixel"), mm.get("pin_pixel")
    if not isinstance(tee_px, dict) or not isinstance(pin_px, dict):
        raise RuntimeError("HoleModel lacks tee/pin minimap anchors")
    tx, ty = float(tee_px["x"]), float(tee_px["y"])
    px, py = float(pin_px["x"]), float(pin_px["y"])
    pfx, pfy = norm(px - tx, py - ty)
    prx, pry = pfy, -pfx

    tee, pin = row["teePos"], row["pinPos"]
    wx0, wz0 = float(tee["x"]), float(tee["z"])
    wx1, wz1 = float(pin["x"]), float(pin["z"])
    wfx, wfz = norm(wx1 - wx0, wz1 - wz0)
    wrx, wrz = wfz, -wfx
    world_xz_yds = math.hypot(wx1 - wx0, wz1 - wz0) * YARDS_PER_WORLD_UNIT
    pixel_dist = math.hypot(px - tx, py - ty)
    return {
        "tee_pixel": {"x": tx, "y": ty},
        "pin_pixel": {"x": px, "y": py},
        "pixel_forward_unit": [pfx, pfy],
        "pixel_right_unit": [prx, pry],
        "tee_world_xz": [wx0, wz0],
        "pin_world_xz": [wx1, wz1],
        "world_forward_unit_xz": [wfx, wfz],
        "world_right_unit_xz": [wrx, wrz],
        "world_xz_tee_to_pin_yds": world_xz_yds,
        "pixel_tee_to_pin": pixel_dist,
        "yards_per_pixel": world_xz_yds / pixel_dist,
    }


def pixel_to_local(t: dict[str, Any], x: float, y: float) -> tuple[float, float]:
    dx = x - float(t["tee_pixel"]["x"])
    dy = y - float(t["tee_pixel"]["y"])
    pfx, pfy = t["pixel_forward_unit"]
    prx, pry = t["pixel_right_unit"]
    scale = float(t["yards_per_pixel"])
    return (dx * prx + dy * pry) * scale, (dx * pfx + dy * pfy) * scale


def local_to_world(t: dict[str, Any], lateral: float, forward: float) -> tuple[float, float]:
    wx0, wz0 = t["tee_world_xz"]
    wfx, wfz = t["world_forward_unit_xz"]
    wrx, wrz = t["world_right_unit_xz"]
    inv = 1.0 / YARDS_PER_WORLD_UNIT
    return wx0 + (forward * wfx + lateral * wrx) * inv, wz0 + (forward * wfz + lateral * wrz) * inv


def rep_points_pixels(rep: dict[str, Any], width: float, height: float):
    pts = rep.get("points")
    if not isinstance(pts, list):
        return None
    if rep.get("coordinate_space") == "minimap_normalized":
        return [(float(p[0]) * width, float(p[1]) * height) for p in pts]
    if rep.get("coordinate_space") == "minimap_pixel":
        return [(float(p[0]), float(p[1])) for p in pts]
    return None


def project_hazard(hazard: dict[str, Any], transform: dict[str, Any], width: float, height: float):
    primary = hazard.get("primary") or {}
    rep = primary.get("representation") or {}
    pixels = rep_points_pixels(rep, width, height)
    if not pixels:
        return None
    local, world = [], []
    for x, y in pixels:
        lat, fwd = pixel_to_local(transform, x, y)
        wx, wz = local_to_world(transform, lat, fwd)
        local.append({"lateral_yds": lat, "forward_yds": fwd})
        world.append({"x": wx, "z": wz})
    lats = [p["lateral_yds"] for p in local]
    fwds = [p["forward_yds"] for p in local]
    return {
        "hazard_key": hazard.get("hazard_key"),
        "hazard_class": hazard.get("hazard_class"),
        "source": primary.get("source"),
        "confidence": primary.get("confidence"),
        "validation": primary.get("validation"),
        "geometry_type": rep.get("geometry_type"),
        "minimap_points_pixel": [[x, y] for x, y in pixels],
        "hole_local_yards": local,
        "gspro_world_xz": world,
        "bounds_local_yards": {
            "lateral_min": min(lats), "lateral_max": max(lats),
            "forward_min": min(fwds), "forward_max": max(fwds),
        },
    }


def build_model(capture: Path, output_log: Path) -> dict[str, Any]:
    hole_model = read_json(capture / "hole_model.json")
    hazard_map = read_json(capture / "hazard_map_shadow_v0.json")
    context = read_json(capture / "capture_context.json")
    pin_yds = float((hole_model.get("base_geometry") or {})["pin_distance_yds"])
    par = context.get("par") or ((context.get("identity") or {}).get("par"))
    hole_display = context.get("hole_number") or ((hazard_map.get("identity") or {}).get("hole_display"))
    arrays = course_layout_arrays(output_log.read_text(encoding="utf-8", errors="ignore"))
    if not arrays:
        raise RuntimeError("GSPro output_log has no course-layout teePos/pinPos array yet")
    row, match = select_layout_row(arrays[-1], pin_yds, int(par) if par is not None else None, int(hole_display) if hole_display is not None else None)
    transform = anchor_transform(hole_model, row)
    bbox = (hole_model.get("minimap") or {}).get("bbox") or []
    if len(bbox) != 4:
        raise RuntimeError("HoleModel minimap bbox unavailable")
    width, height = float(bbox[2]), float(bbox[3])
    hazards, skipped = [], []
    for h in hazard_map.get("hazards") or []:
        projected = project_hazard(h, transform, width, height)
        if projected is None:
            skipped.append({"hazard_key": h.get("hazard_key"), "reason": "primary geometry has no minimap polygon/polyline points"})
        else:
            hazards.append(projected)
    return {
        "schema_version": SCHEMA_VERSION,
        "capture_id": capture.name,
        "identity": {
            "course_name": context.get("course_name") or (hazard_map.get("identity") or {}).get("course_name"),
            "course_key": context.get("course_key") or (hazard_map.get("identity") or {}).get("course_key"),
            "round_id": context.get("round_id") or (hazard_map.get("identity") or {}).get("round_id"),
            "hole_display": hole_display,
            "par": par,
        },
        "coordinate_contract": {
            "live_ball_input": "GSPro world X/Z from currentRound EndingPOS",
            "canonical_live_space": "hole_local_yards",
            "axes": {"lateral": "right-positive", "forward": "tee-toward-pin-positive"},
            "yards_per_world_unit": YARDS_PER_WORLD_UNIT,
        },
        "anchors": {
            "tee_world_xyz": row.get("teePos"),
            "pin_world_xyz": row.get("pinPos"),
            "tee_minimap_pixel": transform["tee_pixel"],
            "pin_minimap_pixel": transform["pin_pixel"],
            "match": match,
        },
        "transform": transform,
        "hazard_count": len(hazards),
        "hazard_class_counts": hazard_map.get("canonical_class_counts") or {},
        "hazards": hazards,
        "skipped_hazards": skipped,
        "source_hazard_map": "hazard_map_shadow_v0.json",
        "source_hole_model": "hole_model.json",
        "strategy_authority": False,
    }


def process_capture(capture: Path, output_log: Path, force: bool = False) -> bool:
    out = capture / "hole_spatial_model_v1.json"
    if out.is_file() and not force:
        return True
    required = [capture / "hole_model.json", capture / "hazard_map_shadow_v0.json", capture / "capture_context.json"]
    if not all(p.is_file() for p in required) or not output_log.is_file():
        return False
    payload = build_model(capture, output_log)
    write_json(out, payload)
    ident = payload.get("identity") or {}
    print(f"H{ident.get('hole_display','?')} SPATIAL MODEL READY | hazards={payload['hazard_count']} | anchor_error={payload['anchors']['match']['distance_error_yds']:.2f}yd", flush=True)
    return True


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build/watch Looper hole spatial model v1")
    p.add_argument("--output-root", required=True)
    p.add_argument("--gspro-dir", required=True)
    p.add_argument("--output-log")
    p.add_argument("--capture-dir")
    p.add_argument("--poll-ms", type=float, default=500.0)
    p.add_argument("--once", action="store_true")
    p.add_argument("--force", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.output_root).expanduser().resolve()
    gspro = Path(args.gspro_dir).expanduser().resolve()
    output_log = Path(args.output_log).expanduser().resolve() if args.output_log else gspro / "output_log.txt"
    if args.capture_dir:
        process_capture(Path(args.capture_dir).expanduser().resolve(), output_log, force=args.force)
        return 0
    seen: set[str] = set()
    try:
        while True:
            for capture in sorted([p for p in root.glob("tee_capture_*") if p.is_dir()], key=lambda p: p.stat().st_mtime):
                if capture.name in seen and not args.force:
                    continue
                try:
                    if process_capture(capture, output_log, force=args.force):
                        seen.add(capture.name)
                except Exception as exc:
                    if args.once:
                        print(f"{capture.name}: spatial model pending: {exc}", flush=True)
            if args.once:
                return 0
            time.sleep(max(0.1, float(args.poll_ms) / 1000.0))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
