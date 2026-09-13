#!/usr/bin/env python3
"""Profile-aware carry-arc fairway extractor for Looper strategy shadow work.

v1 keeps the physically correct v0 carry-radius primitive but tightens the semantic
question and adds useful downstream evidence in the same pass:
- optional cached course visual profile (existing GSPro surface labels only);
- exact fairway span(s) on one carry arc;
- known bunker / penalty / OB geometry rendered on the same screenshot;
- three interior landing candidates per accepted span;
- geometry-only hazard clearances for those candidates.

No recommendation, no new lie taxonomy, no gameplay penalty inference, no GSPro input.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
from pathlib import Path
import time
from typing import Any, Iterable
from urllib import error as urlerror
from urllib import request as urlrequest

import cv2
import numpy as np

import hazard_vlm_openai as openai_adapter
import strategy_carry_arc_v0 as v0
import strategy_risk_v0 as risk
import strategy_risk_overlay_v0 as risk_overlay

SCHEMA_VERSION = "looper-strategy-carry-arc-v1"
PROMPT_REVISION = "carry-arc-current-hole-surface-v1.1"
DEFAULT_LUNA_MODEL = "gpt-5.6-luna"
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
RETRYABLE_HTTP = {408, 409, 429, 500, 502, 503, 504}
DEFAULT_CARRIES = (180.0, 200.0, 220.0, 240.0, 260.0)

SYSTEM = """You analyze a GSPro golf-simulator TEE minimap for Looper.

The image contains ONE thin DASHED MAGENTA CARRY ARC centered on the current ball.
The magenta arc is an artificial Looper overlay, not a golf-course feature. Every
point on it is the same carry distance from the ball.

Your ONLY geometry task is to identify the CURRENT-HOLE FAIRWAY SURFACE where that
one magenta carry arc visibly crosses it.

Use this reasoning order:
1. Locate the current ball/player marker and the target white pin/green.
2. Visually follow the maintained CURRENT-HOLE playing route from the ball toward the
   target green. A dogleg may bend substantially away from the direct ball-to-pin line.
   Do NOT assume the tee-to-pin straight line is the fairway centerline.
3. Inspect only where the magenta carry arc crosses that current-hole route.
4. Place edge points exactly where the magenta arc crosses a visible transition from
   current-hole FAIRWAY to a non-fairway surface.

Surface rules:
- FAIRWAY means the visibly maintained fairway surface of the current hole.
- GREEN is not fairway. If the arc crosses only the green, do not call it fairway.
- ROUGH and DEEP_ROUGH are not fairway.
- BUNKER, water, cart paths, roads, tee boxes, buildings, UI, red penalty lines and
  white OB lines are not fairway.
- If a bunker/water/non-fairway feature interrupts what would otherwise be one fairway
  crossing, return separate fairway spans on either side only when both are visibly
  part of the SAME current hole.
- Neighboring-hole fairways are never valid, even when they are closer to the pin line
  or visually similar.
- Return multiple spans only for genuinely disconnected CURRENT-HOLE fairway pieces
  on this one carry arc, not for nearby holes.

For each returned span:
- edge_a_xy_1000 and edge_b_xy_1000 are the two visible FAIRWAY boundary crossings
  on the magenta carry arc;
- center_xy_1000 lies on the same magenta carry arc AND visibly inside that fairway
  span between the two edge points;
- coordinates are [x,y] integers in 0-1000 image coordinates.

If the carry arc does not visibly cross the current-hole fairway, return present=false
and an empty spans array. Prefer visible evidence over guessing.

A course visual profile may be supplied as a WEAK APPEARANCE PRIOR. It can help you
recognize how fairway/rough/bunker/green are rendered on this course, but it must
NEVER create geometry that is not visible in this screenshot.

Return only structured JSON matching the supplied schema."""


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def discover_course_profile(root: Path) -> Path | None:
    candidates = sorted(root.glob("course_profiles/*/course_visual_profile_v0.json"))
    return candidates[0] if len(candidates) == 1 else (max(candidates, key=lambda p: p.stat().st_mtime) if candidates else None)


def load_course_profile(path: str | Path | None) -> tuple[dict[str, Any] | None, str | None]:
    if not path:
        return None, None
    p = Path(path).expanduser().resolve()
    if not p.is_file():
        return None, None
    try:
        raw = read_json(p)
    except Exception:
        return None, None
    profile = raw.get("profile") if isinstance(raw.get("profile"), dict) else raw
    return profile if isinstance(profile, dict) else None, str(p)


def profile_prompt_text(profile: dict[str, Any] | None) -> str:
    if not profile:
        return "No cached course visual profile is supplied; use only this screenshot."
    surfaces = profile.get("surfaces") or {}
    lines = ["WEAK COURSE VISUAL PRIOR (appearance only; screenshot evidence overrides it):"]
    summary = str(profile.get("course_style_summary") or "").strip()
    if summary:
        lines.append(f"Course rendering summary: {summary[:500]}")
    for name in ("fairway", "rough", "deep_rough", "bunker", "green", "water"):
        row = surfaces.get(name) if isinstance(surfaces, dict) else None
        if not isinstance(row, dict) or not row.get("observable"):
            continue
        appearance = str(row.get("appearance") or "").strip()
        cues = [str(x).strip() for x in (row.get("distinguishing_cues") or []) if str(x).strip()]
        text = appearance
        if cues:
            text = (text + "; cues: " + ", ".join(cues[:4])).strip("; ")
        if text:
            lines.append(f"{name.upper()}: {text[:550]}")
    disambig = [str(x).strip() for x in (profile.get("current_hole_disambiguation_cues") or []) if str(x).strip()]
    if disambig:
        lines.append("Current-hole disambiguation cues: " + "; ".join(disambig[:5]))
    lines.append("Do not infer any surface or boundary that is not visibly supported in this hole screenshot.")
    return "\n".join(lines)[:3500]


def _user_instruction(carry_yds: float, profile: dict[str, Any] | None) -> str:
    return (
        f"The dashed magenta arc is exactly {carry_yds:.0f} yards from the current ball. "
        "Identify only the CURRENT-HOLE fairway span(s) visibly crossed by this arc. "
        "Put each edge point on the visible fairway boundary crossing and the center point visibly inside the same fairway span.\n\n"
        + profile_prompt_text(profile)
    )


def call_luna(image_path: Path, *, carry_yds: float, profile: dict[str, Any] | None,
              model: str = DEFAULT_LUNA_MODEL, timeout_seconds: float = 70.0, retries: int = 3) -> tuple[dict[str, Any], dict[str, Any]]:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not available")
    body = {
        "model": model,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": SYSTEM}]},
            {"role": "user", "content": [
                {"type": "input_image", "image_url": f"data:{openai_adapter._mime(image_path)};base64,{base64.b64encode(image_path.read_bytes()).decode('ascii')}", "detail": "original"},
                {"type": "input_text", "text": _user_instruction(carry_yds, profile)},
            ]},
        ],
        "text": {"format": {"type": "json_schema", "name": "looper_strategy_carry_arc_v1", "strict": True, "schema": v0.semantic_schema()}},
        "reasoning": {"effort": "none"},
        "max_output_tokens": 2048,
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urlrequest.Request(openai_adapter.API_URL, data=json.dumps(body).encode("utf-8"), headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            result = v0.normalize_semantic(json.loads(openai_adapter._extract_output_text(raw)))
            return result, {"provider": "openai-luna", "model": model, "latency_seconds": time.perf_counter() - started, "response_id": raw.get("id"), "usage_metadata": raw.get("usage") or {}}
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last = RuntimeError(f"OpenAI HTTP {exc.code}: {detail[:1200]}")
            if exc.code not in RETRYABLE_HTTP or attempt + 1 >= retries:
                raise last
        except urlerror.URLError as exc:
            last = RuntimeError(f"OpenAI network error: {exc}")
            if attempt + 1 >= retries:
                raise last
        time.sleep(min(8.0, 1.25 * (2 ** attempt)))
    raise last or RuntimeError("Luna carry-arc v1 localization failed")


def _gemini_output(payload: dict[str, Any]) -> dict[str, Any]:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    text = "".join(str(part.get("text") or "") for part in parts).strip()
    if not text:
        raise RuntimeError("Gemini returned no JSON")
    return json.loads(text)


def call_gemini(image_path: Path, *, carry_yds: float, profile: dict[str, Any] | None,
                model: str = DEFAULT_GEMINI_MODEL, timeout_seconds: float = 90.0, retries: int = 3) -> tuple[dict[str, Any], dict[str, Any]]:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not available")
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": openai_adapter._mime(image_path), "data": base64.b64encode(image_path.read_bytes()).decode("ascii")}},
            {"text": _user_instruction(carry_yds, profile)},
        ]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": v0.gemini_semantic_schema(), "maxOutputTokens": 2048, "thinkingConfig": {"thinkingLevel": "minimal"}},
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urlrequest.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json", "x-goog-api-key": key}, method="POST")
        try:
            with urlrequest.urlopen(req, timeout=timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            return v0.normalize_semantic(_gemini_output(raw)), {"provider": "google-gemini", "model": model, "latency_seconds": time.perf_counter() - started, "usage_metadata": raw.get("usageMetadata") or {}}
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last = RuntimeError(f"Gemini HTTP {exc.code}: {detail[:1200]}")
            if exc.code not in RETRYABLE_HTTP or attempt + 1 >= retries:
                raise last
        except urlerror.URLError as exc:
            last = RuntimeError(f"Gemini network error: {exc}")
            if attempt + 1 >= retries:
                raise last
        time.sleep(min(8.0, 1.5 * (2 ** attempt)))
    raise last or RuntimeError("Gemini carry-arc v1 localization failed")


def call_provider_chain(image_path: Path, *, carry_yds: float, profile: dict[str, Any] | None,
                        provider: str = "luna", fallback_provider: str | None = "gemini") -> tuple[dict[str, Any], dict[str, Any]]:
    chain = [provider]
    if fallback_provider and fallback_provider.lower() != provider.lower():
        chain.append(fallback_provider)
    attempts = []
    last: Exception | None = None
    for index, name in enumerate(chain):
        try:
            if name.lower() in {"luna", "openai"}:
                result, meta = call_luna(image_path, carry_yds=carry_yds, profile=profile)
            elif name.lower() in {"gemini", "google"}:
                result, meta = call_gemini(image_path, carry_yds=carry_yds, profile=profile)
            else:
                raise ValueError(f"unsupported provider {name!r}")
            attempts.append({"provider": name, "status": "complete", "latency_seconds": meta.get("latency_seconds")})
            return result, {**meta, "provider_attempts": attempts, "fallback_used": index > 0}
        except Exception as exc:
            last = exc
            attempts.append({"provider": name, "status": "error", "error": f"{type(exc).__name__}: {exc}"})
    raise RuntimeError(f"all carry-arc v1 providers failed: {attempts}") from last


def _wrap_angle(value: float) -> float:
    while value <= -math.pi:
        value += 2 * math.pi
    while value > math.pi:
        value -= 2 * math.pi
    return value


def point_on_span(left: tuple[float, float], right: tuple[float, float], carry_yds: float, fraction: float) -> tuple[float, float]:
    a = v0._angle_from_origin(left, (0.0, 0.0))
    b = v0._angle_from_origin(right, (0.0, 0.0))
    delta = _wrap_angle(b - a)
    theta = a + delta * float(fraction)
    return carry_yds * math.sin(theta), carry_yds * math.cos(theta)


def candidate_clearance(geometry: dict[str, Any], point: tuple[float, float]) -> dict[str, Any]:
    nearest = {"bunker": None, "penalty_area": None, "out_of_bounds": None}
    inside_bunker = False
    for layer in risk.geometry_local_layers(geometry):
        cls = str(layer.get("hazard_class"))
        if cls not in nearest:
            continue
        points = layer.get("points_local_yards") or []
        if len(points) < 2:
            continue
        closed = cls == "bunker"
        if closed and risk._point_in_polygon(point[0], point[1], points):
            inside_bunker = True
            clearance = 0.0
        else:
            segments = list(risk._poly_segments(points, closed=closed))
            clearance = min((risk._segment_euclidean_distance(point, a, b) for a, b in segments), default=None)
        if clearance is not None and (nearest[cls] is None or clearance < nearest[cls]):
            nearest[cls] = clearance
    return {
        "inside_bunker": inside_bunker,
        "nearest_clearance_yds": nearest,
        "boundary_side_probability": "unavailable",
    }


def span_candidates(span: dict[str, Any], carry_yds: float, geometry: dict[str, Any], transform: dict[str, Any]) -> list[dict[str, Any]]:
    left = span.get("left_local_yards") or {}
    right = span.get("right_local_yards") or {}
    if not left or not right:
        return []
    a = (float(left["lateral"]), float(left["forward"]))
    b = (float(right["lateral"]), float(right["forward"]))
    rows = []
    for label, fraction in (("span-left-interior", 0.20), ("span-center", 0.50), ("span-right-interior", 0.80)):
        local = point_on_span(a, b, carry_yds, fraction)
        pixel = v0.local_to_pixel(transform, local[0], local[1])
        rows.append({
            "label": label,
            "fraction_along_span": fraction,
            "local_yards": {"lateral": local[0], "forward": local[1]},
            "pixel": {"x": pixel[0], "y": pixel[1]},
            "hazard_clearance": candidate_clearance(geometry, local),
            "recommendation": None,
            "strategy_authority": False,
        })
    return rows


def draw_overlay(image: np.ndarray, geometry: dict[str, Any], transform: dict[str, Any], carry_yds: float,
                 spans: list[dict[str, Any]], candidates_by_span: dict[int, list[dict[str, Any]]]) -> np.ndarray:
    out = image.copy()
    try:
        risk_overlay._draw_hazards(out, geometry)
    except Exception:
        pass
    out = v0.annotate_carry_arc(out, transform, carry_yds)
    for span in spans:
        if not span.get("accepted"):
            continue
        left = span["left_local_yards"]
        right = span["right_local_yards"]
        v0._draw_arc_segment(out, transform, carry_yds,
                             (float(left["lateral"]), float(left["forward"])),
                             (float(right["lateral"]), float(right["forward"])))
        for row in candidates_by_span.get(int(span["span_id"]), []):
            px = row["pixel"]
            color = (255, 255, 255) if row["label"] == "span-center" else (0, 255, 255)
            cv2.circle(out, (int(round(px["x"])), int(round(px["y"]))), 5, color, -1, cv2.LINE_AA)
    return out


def extract_carry(capture: Path, *, carry_yds: float, profile: dict[str, Any] | None = None,
                  profile_source: str | None = None, provider: str = "luna",
                  fallback_provider: str | None = "gemini", force: bool = False) -> dict[str, Any]:
    capture = capture.expanduser().resolve()
    carry_key = int(round(carry_yds))
    output_path = capture / f"strategy_carry_arc_{carry_key:04d}_v1.json"
    if output_path.is_file() and not force:
        return read_json(output_path)
    geometry = v0.load_strategy_geometry(capture)
    transform = geometry.get("coordinate_transform") or {}
    source = v0.find_source_image(capture)
    image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read {source}")
    prompt = v0.annotate_carry_arc(image, transform, carry_yds)
    prompt_name = f"strategy_carry_arc_{carry_key:04d}_prompt_v1.png"
    cv2.imwrite(str(capture / prompt_name), prompt)
    semantic, provider_meta = call_provider_chain(capture / prompt_name, carry_yds=carry_yds, profile=profile,
                                                  provider=provider, fallback_provider=fallback_provider)
    validated = [
        v0.validate_span(row, carry_yds=carry_yds, transform=transform,
                         image_width=image.shape[1], image_height=image.shape[0])
        for row in semantic.get("spans") or []
    ]
    accepted = [row for row in validated if row.get("accepted")]
    candidates_by_span: dict[int, list[dict[str, Any]]] = {}
    warnings = []
    for span in accepted:
        rows = span_candidates(span, carry_yds, geometry, transform)
        candidates_by_span[int(span["span_id"])] = rows
        if any(row["hazard_clearance"].get("inside_bunker") for row in rows):
            warnings.append(f"span-{span['span_id']}-interior-candidate-inside-known-bunker")
    overlay = draw_overlay(image, geometry, transform, carry_yds, validated, candidates_by_span)
    overlay_name = f"strategy_carry_arc_{carry_key:04d}_overlay_v1.png"
    cv2.imwrite(str(capture / overlay_name), overlay)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "prompt_revision": PROMPT_REVISION,
        "identity": geometry.get("identity") or {"capture_id": capture.name},
        "carry_yds": float(carry_yds),
        "visual_truth": {"source_image": source.name},
        "course_visual_profile": {"used": bool(profile), "source": profile_source},
        "prompt_artifact": prompt_name,
        "overlay_artifact": overlay_name,
        "semantic_present": semantic.get("present"),
        "semantic_note": semantic.get("note"),
        "spans": validated,
        "span_candidates": candidates_by_span,
        "accepted_span_count": len(accepted),
        "provider": provider_meta,
        "qa": {
            "max_radial_residual_yds": v0.MAX_RADIAL_RESIDUAL_YDS,
            "min_chord_width_yds": v0.MIN_CHORD_WIDTH_YDS,
            "max_chord_width_yds": v0.MAX_CHORD_WIDTH_YDS,
            "warnings": warnings,
        },
        "interpretation": {
            "primitive": "carry-radius arc intersected with visible current-hole fairway",
            "course_profile": "weak appearance prior only",
            "candidate_points": "interior geometry probes, not recommendations or GSPro aim points",
            "known_hazards": "rendered/evaluated from existing screenshot strategy geometry",
            "physics_taxonomy": "unchanged GSPro surface/lie classes",
        },
        "strategy_authority": False,
        "recommendation": None,
    }
    write_json(output_path, payload)
    return payload


def extract_capture(capture: Path, *, carries_yds: Iterable[float] = DEFAULT_CARRIES,
                    profile: dict[str, Any] | None = None, profile_source: str | None = None,
                    provider: str = "luna", fallback_provider: str | None = "gemini",
                    force: bool = False) -> dict[str, Any]:
    requested = list(carries_yds)
    eligible = v0.eligible_carries(capture, requested)
    meta = v0.hole_metadata(capture)
    rows = [
        extract_carry(capture, carry_yds=carry, profile=profile, profile_source=profile_source,
                      provider=provider, fallback_provider=fallback_provider, force=force)
        for carry in eligible
    ]
    payload = {
        "schema_version": SCHEMA_VERSION,
        "prompt_revision": PROMPT_REVISION,
        "identity": {"capture_id": capture.name, **meta},
        "requested_carries_yds": requested,
        "eligible_carries_yds": eligible,
        "course_visual_profile": {"used": bool(profile), "source": profile_source},
        "carry_results": [
            {"carry_yds": row["carry_yds"], "accepted_span_count": row["accepted_span_count"],
             "overlay_artifact": row["overlay_artifact"], "prompt_artifact": row["prompt_artifact"]}
            for row in rows
        ],
        "strategy_authority": False,
        "recommendation": None,
    }
    write_json(capture / "strategy_carry_arc_v1.json", payload)
    return payload


def parse_carries(value: str | None) -> list[float]:
    if not value:
        return list(DEFAULT_CARRIES)
    return [float(x.strip()) for x in value.split(",") if x.strip()]


def main() -> int:
    p = argparse.ArgumentParser(description="Profile-aware current-hole carry-arc fairway extraction")
    p.add_argument("--capture-root", action="append", default=[])
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--carries", default=",".join(str(int(x)) for x in DEFAULT_CARRIES))
    p.add_argument("--course-profile-json")
    p.add_argument("--provider", default="luna")
    p.add_argument("--fallback-provider", default="gemini")
    p.add_argument("--latest", type=int, default=0)
    p.add_argument("--force", action="store_true")
    args = p.parse_args()
    roots = [*args.capture_root, *args.capture_dir]
    captures = v0.capture_dirs(roots)
    if args.latest > 0:
        captures = captures[-args.latest:]
    if not captures:
        print("No replayable tee capture folders found.")
        return 1
    root_for_profile = Path(args.capture_root[0]).expanduser().resolve() if args.capture_root else captures[0].parent
    profile_path = Path(args.course_profile_json).expanduser().resolve() if args.course_profile_json else discover_course_profile(root_for_profile)
    profile, profile_source = load_course_profile(profile_path)
    carries = parse_carries(args.carries)
    failures = 0
    print("Looper Strategy Carry Arc v1")
    print(f"Prompt={PROMPT_REVISION} | course-profile={'YES' if profile else 'NO'} | carries={','.join(str(int(x)) for x in carries)}")
    print("Existing GSPro physics taxonomy only. No new lie classes. Strategy authority OFF.")
    for capture in captures:
        try:
            payload = extract_capture(capture, carries_yds=carries, profile=profile, profile_source=profile_source,
                                      provider=args.provider, fallback_provider=(args.fallback_provider or None), force=args.force)
            ident = payload.get("identity") or {}
            rows = payload.get("carry_results") or []
            summary = ", ".join(f"{int(r['carry_yds'])}y:{r['accepted_span_count']}" for r in rows) or "SKIP"
            print(f"H{ident.get('hole_display','?')} carry-arc-v1 | {summary} | {capture.name}")
        except Exception as exc:
            failures += 1
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")
    print("Strategy authority: OFF | Recommendation: NONE")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
