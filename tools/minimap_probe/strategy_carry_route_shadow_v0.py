#!/usr/bin/env python3
"""Join independent carry-arc fairway spans into a coherent shadow route.

This is a diagnostic consistency layer, not an aim engine. Independent Luna calls at
180/200/220/... yards should describe the same current hole. A dynamic-programming
chain rewards semantic confidence and smooth bearing progression, which helps expose
neighboring-hole mistakes without reconstructing a full fairway polygon.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

import strategy_carry_arc_v0 as arc0
import strategy_risk_overlay_v0 as risk_overlay

SCHEMA_VERSION = "looper-strategy-carry-route-shadow-v0"
ANGLE_PENALTY_PER_DEG_AT_20Y = 0.028
CONFIDENCE_WEIGHT = 3.0
LARGE_JUMP_WARNING_DEG_AT_20Y = 45.0


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def angle_deg(point: dict[str, Any]) -> float:
    return math.degrees(math.atan2(float(point["lateral"]), float(point["forward"])))


def wrap_delta_deg(a: float, b: float) -> float:
    value = (float(b) - float(a) + 180.0) % 360.0 - 180.0
    return value


def carry_candidates(capture: Path) -> list[dict[str, Any]]:
    aggregate = capture / "strategy_carry_arc_v1.json"
    if not aggregate.is_file():
        return []
    summary = read_json(aggregate)
    rows = []
    for item in summary.get("carry_results") or []:
        carry = int(round(float(item["carry_yds"])))
        detail_path = capture / f"strategy_carry_arc_{carry:04d}_v1.json"
        if not detail_path.is_file():
            continue
        detail = read_json(detail_path)
        candidates = []
        for span in detail.get("spans") or []:
            if not span.get("accepted"):
                continue
            center = span.get("center_local_yards") or {}
            if center.get("lateral") is None or center.get("forward") is None:
                continue
            point = {"lateral": float(center["lateral"]), "forward": float(center["forward"])}
            candidates.append({
                "carry_yds": float(carry),
                "span_id": int(span["span_id"]),
                "semantic_confidence": float(span.get("semantic_confidence", 0.0)),
                "chord_width_yds": span.get("chord_width_yds"),
                "center_local_yards": point,
                "bearing_deg": angle_deg(point),
                "left_local_yards": span.get("left_local_yards"),
                "right_local_yards": span.get("right_local_yards"),
            })
        if candidates:
            rows.append({"carry_yds": float(carry), "candidates": candidates})
    rows.sort(key=lambda row: row["carry_yds"])
    return rows


def best_route(stations: list[dict[str, Any]]) -> dict[str, Any]:
    if not stations:
        return {"available": False, "reason": "no accepted carry-arc spans", "route": [], "warnings": []}
    dp: list[list[dict[str, Any]]] = []
    for station_index, station in enumerate(stations):
        state_rows = []
        for candidate_index, candidate in enumerate(station["candidates"]):
            base_score = CONFIDENCE_WEIGHT * float(candidate["semantic_confidence"])
            if station_index == 0:
                state_rows.append({"score": base_score, "prev": None, "transition_delta_deg": None})
                continue
            previous_station = stations[station_index - 1]
            previous_states = dp[station_index - 1]
            best_state = None
            delta_carry = max(1.0, float(station["carry_yds"]) - float(previous_station["carry_yds"]))
            scale = 20.0 / max(20.0, delta_carry)
            for prev_index, prev_candidate in enumerate(previous_station["candidates"]):
                delta = abs(wrap_delta_deg(prev_candidate["bearing_deg"], candidate["bearing_deg"]))
                score = previous_states[prev_index]["score"] + base_score - ANGLE_PENALTY_PER_DEG_AT_20Y * scale * delta
                row = {"score": score, "prev": prev_index, "transition_delta_deg": delta}
                if best_state is None or row["score"] > best_state["score"]:
                    best_state = row
            state_rows.append(best_state or {"score": base_score, "prev": None, "transition_delta_deg": None})
        dp.append(state_rows)

    finals = sorted(enumerate(dp[-1]), key=lambda pair: pair[1]["score"], reverse=True)
    best_final_index, best_final = finals[0]
    second_score = finals[1][1]["score"] if len(finals) > 1 else None
    chosen_indices = [None] * len(stations)
    idx = best_final_index
    for station_index in range(len(stations) - 1, -1, -1):
        chosen_indices[station_index] = idx
        idx = dp[station_index][idx].get("prev")
        if station_index > 0 and idx is None:
            idx = 0

    route = []
    warnings = []
    for station_index, candidate_index in enumerate(chosen_indices):
        candidate = dict(stations[station_index]["candidates"][candidate_index])
        transition = dp[station_index][candidate_index].get("transition_delta_deg")
        candidate["transition_delta_deg"] = transition
        if transition is not None:
            delta_carry = float(candidate["carry_yds"]) - float(route[-1]["carry_yds"])
            allowed = LARGE_JUMP_WARNING_DEG_AT_20Y * max(1.0, delta_carry / 20.0)
            if transition > allowed:
                warnings.append(f"large-route-bearing-jump:{transition:.1f}deg at {candidate['carry_yds']:.0f}yd")
        route.append(candidate)

    return {
        "available": True,
        "route": route,
        "route_score": float(best_final["score"]),
        "second_best_final_score": second_score,
        "final_score_margin": None if second_score is None else float(best_final["score"] - second_score),
        "warnings": warnings,
        "interpretation": "smoothest high-confidence chain across independent carry-arc fairway spans; diagnostic only",
    }


def build_overlay(capture: Path, geometry: dict[str, Any], route_payload: dict[str, Any]) -> str | None:
    source = arc0.find_source_image(capture)
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        return None
    out = image.copy()
    try:
        risk_overlay._draw_hazards(out, geometry)
    except Exception:
        pass
    transform = geometry.get("coordinate_transform") or {}
    route = route_payload.get("route") or []
    centers = []
    for row in route:
        carry = float(row["carry_yds"])
        left = row.get("left_local_yards") or {}
        right = row.get("right_local_yards") or {}
        if left and right:
            arc0._draw_arc_segment(out, transform, carry,
                                   (float(left["lateral"]), float(left["forward"])),
                                   (float(right["lateral"]), float(right["forward"])))
        center = row["center_local_yards"]
        px = arc0.local_to_pixel(transform, float(center["lateral"]), float(center["forward"]))
        point = (int(round(px[0])), int(round(px[1])))
        centers.append(point)
        cv2.circle(out, point, 6, (255,255,255), -1, cv2.LINE_AA)
        cv2.putText(out, f"{int(round(carry))}", (point[0]+5, point[1]-5), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0,0,0), 3, cv2.LINE_AA)
        cv2.putText(out, f"{int(round(carry))}", (point[0]+5, point[1]-5), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (255,255,255), 1, cv2.LINE_AA)
    if len(centers) >= 2:
        cv2.polylines(out, [np.asarray(centers, dtype=np.int32).reshape((-1,1,2))], False, (255, 200, 0), 2, cv2.LINE_AA)
    name = "strategy_carry_route_shadow_v0.png"
    cv2.imwrite(str(capture / name), out)
    return name


def build(capture: Path) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    stations = carry_candidates(capture)
    route = best_route(stations)
    geometry = arc0.load_strategy_geometry(capture)
    overlay = build_overlay(capture, geometry, route) if route.get("available") else None
    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": geometry.get("identity") or {"capture_id": capture.name},
        "carry_station_count": len(stations),
        "stations": stations,
        **route,
        "overlay_artifact": overlay,
        "strategy_authority": False,
        "recommendation": None,
    }
    write_json(capture / "strategy_carry_route_shadow_v0.json", payload)
    return payload


def main() -> int:
    p = argparse.ArgumentParser(description="Join carry-arc fairway spans into a shadow route")
    p.add_argument("--capture-root", default="tools/minimap_probe/output")
    p.add_argument("--latest", type=int, default=18)
    args = p.parse_args()
    captures = arc0.capture_dirs([args.capture_root])
    if args.latest > 0:
        captures = captures[-args.latest:]
    failures = 0
    for capture in captures:
        try:
            payload = build(capture)
            ident = payload.get("identity") or {}
            print(f"H{ident.get('hole_display','?')} route={'YES' if payload.get('available') else 'NO'} | carries={payload.get('carry_station_count',0)} | warnings={len(payload.get('warnings') or [])}")
        except Exception as exc:
            failures += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("Route consistency only. No recommendation. Strategy authority OFF.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
