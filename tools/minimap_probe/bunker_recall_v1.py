#!/usr/bin/env python3
"""Recall-first bunker discovery for saved GSPro tee minimaps.

Architecture:
- original GSPro minimap remains visual truth;
- Luna proposes every plausible current-hole bunker as a tight semantic box;
- SAM2 traces exact pixel edges;
- existing SAM2/legacy bunker polygons are retained as supporting candidates;
- legacy-only geometry needs semantic support before becoming an accepted bunker;
- overlapping candidates are deduplicated with source/quality preference.

Offline saved-capture tool: no GSPro input. Strategy authority remains off.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import mimetypes
import os
from pathlib import Path
import time
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest
import zipfile

import cv2
import numpy as np

import hazard_field_shadow as step8
import hazard_prompt_segment
import hazard_vlm_contract

SCHEMA_VERSION = "looper-bunker-recall-v1"
API_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-5.6-luna"
DEFAULT_SAM_MODEL = hazard_prompt_segment.DEFAULT_SAM2_MODEL
RETRYABLE_HTTP = {408, 409, 429, 500, 502, 503, 504}
STRATEGY_AUTHORITY = False

SYSTEM_INSTRUCTION = """You analyze a GSPro golf-simulator tee minimap for Looper.

Your ONLY job is high-recall localization of sand bunkers that plausibly belong to
the CURRENT HOLE, whose route runs from the player/ball marker toward the pin.

Recall is more important than precision in this pass because a separate local SAM2
segmenter and geometry QA will reject bad candidates. Identify EVERY visibly
plausible current-hole bunker, including:
- very small bunkers;
- narrow bunkers;
- partially obscured or edge-clipped bunkers;
- bunkers near the green;
- bunkers well left or right of the centerline that can affect strategy.

Return ONE tight box per distinct bunker. It is acceptable to include a plausible
candidate when you are uncertain whether sand belongs to the current hole; use a
lower confidence rather than silently omitting it.

Do NOT return water, rough, fairway, green, tee boxes, roads, paths, buildings,
trees, shadows, red penalty lines, white out-of-bounds lines, UI, player markers,
or pin markers. Exclude a bunker only when it is clearly part of an unrelated
neighboring hole.

Return only structured JSON matching the supplied schema. Coordinates are normalized
x1,y1,x2,y2 in [0,1]."""

USER_INSTRUCTION = """Find every visible bunker that plausibly belongs to this current
hole. Bias toward recall. Use one tight normalized box per bunker. Do not merge
separate bunkers into one large box."""


def _schema() -> dict[str, Any]:
    item = {
        "type": "object",
        "additionalProperties": False,
        "required": ["id", "confidence", "bbox_norm", "note"],
        "properties": {
            "id": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "bbox_norm": {
                "type": "array",
                "minItems": 4,
                "maxItems": 4,
                "items": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "note": {"type": ["string", "null"]},
        },
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["schema_version", "bunkers"],
        "properties": {
            "schema_version": {"type": "string", "enum": [SCHEMA_VERSION]},
            "bunkers": {"type": "array", "items": item},
        },
    }


def _mime(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed if guessed in {"image/png", "image/jpeg", "image/webp"} else "image/png"


def _extract_output_text(payload: dict[str, Any]) -> str:
    direct = payload.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    texts: list[str] = []
    for item in payload.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                texts.append(part["text"])
            elif part.get("type") == "refusal":
                raise RuntimeError(f"OpenAI vision request refused: {part.get('refusal')}")
    if texts:
        return "\n".join(texts).strip()
    if payload.get("error"):
        raise RuntimeError(f"OpenAI response error: {payload['error']}")
    raise RuntimeError("OpenAI response contained no output text")


def _validated_box(value: Any) -> tuple[float, float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("bbox_norm must contain four values")
    vals = tuple(float(v) for v in value)
    x1, y1, x2, y2 = vals
    if any(not math.isfinite(v) or v < 0 or v > 1 for v in vals):
        raise ValueError(f"bbox_norm outside [0,1]: {vals}")
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"bbox_norm has non-positive area: {vals}")
    if (x2 - x1) * (y2 - y1) > 0.20:
        raise ValueError(f"bunker box implausibly large: {vals}")
    return vals


def parse_contract(payload: dict[str, Any]) -> list[hazard_vlm_contract.VlmHazard]:
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"wrong schema_version: {payload.get('schema_version')!r}")
    raw = payload.get("bunkers")
    if not isinstance(raw, list):
        raise ValueError("bunkers must be a list")
    out: list[hazard_vlm_contract.VlmHazard] = []
    seen: set[str] = set()
    for i, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise ValueError(f"bunkers[{i}] must be an object")
        hid = str(item.get("id") or f"bunker-{i}")
        if hid in seen:
            raise ValueError(f"duplicate bunker id: {hid}")
        seen.add(hid)
        confidence = float(item.get("confidence"))
        if not 0 <= confidence <= 1:
            raise ValueError(f"confidence outside [0,1]: {confidence}")
        out.append(hazard_vlm_contract.VlmHazard(
            hazard_id=hid,
            hazard_class="bunker",
            confidence=confidence,
            bbox_norm=_validated_box(item.get("bbox_norm")),
            note=None if item.get("note") is None else str(item.get("note")),
        ))
    return out


def call_luna(
    image_path: Path,
    *,
    model: str = DEFAULT_MODEL,
    timeout_seconds: float = 60.0,
    retries: int = 3,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not available in this process.")
    b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    body = {
        "model": model,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": SYSTEM_INSTRUCTION}]},
            {"role": "user", "content": [
                {"type": "input_image", "image_url": f"data:{_mime(image_path)};base64,{b64}", "detail": "original"},
                {"type": "input_text", "text": USER_INSTRUCTION},
            ]},
        ],
        "text": {"format": {
            "type": "json_schema",
            "name": "looper_bunker_recall",
            "strict": True,
            "schema": _schema(),
        }},
        "reasoning": {"effort": "none"},
        "max_output_tokens": 4096,
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urlrequest.Request(
            API_URL,
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            contract = json.loads(_extract_output_text(raw))
            hazards = parse_contract(contract)
            meta = {
                "provider": "openai",
                "model": model,
                "latency_seconds": time.perf_counter() - started,
                "response_id": raw.get("id"),
                "response_status": raw.get("status"),
                "usage_metadata": raw.get("usage") or {},
                "bunker_box_count": len(hazards),
                "strategy_authority": False,
            }
            return contract, meta, raw
        except urlerror.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", errors="replace")
            except Exception:
                detail = str(exc)
            last = RuntimeError(f"OpenAI HTTP {exc.code}: {detail[:1600]}")
            if exc.code not in RETRYABLE_HTTP or attempt + 1 >= retries:
                raise last
        except urlerror.URLError as exc:
            last = RuntimeError(f"OpenAI network error: {exc}")
            if attempt + 1 >= retries:
                raise last
        except (json.JSONDecodeError, ValueError) as exc:
            last = RuntimeError(f"OpenAI bunker contract invalid: {exc}")
            if attempt + 1 >= retries:
                raise last
        time.sleep(min(8.0, 1.25 * (2 ** attempt)))
    raise last or RuntimeError("OpenAI bunker recall failed")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    tmp.replace(path)


def identity(capture: Path) -> dict[str, Any]:
    out: dict[str, Any] = {"capture_id": capture.name}
    context_path = capture / "capture_context.json"
    if context_path.is_file():
        try:
            ctx = read_json(context_path)
            out.update({
                "course_key": ctx.get("course_key"),
                "course_name": ctx.get("course_name"),
                "round_id": ctx.get("round_id"),
                "hole_display": ctx.get("hole_number") or (ctx.get("identity") or {}).get("hole_display"),
                "par": ctx.get("par") or (ctx.get("identity") or {}).get("par"),
            })
        except Exception:
            pass
    hazard_map = capture / "hazard_map_shadow_v0.json"
    if hazard_map.is_file():
        try:
            hident = read_json(hazard_map).get("identity") or {}
            for key in ("course_key", "course_name", "round_id", "hole_display", "par"):
                if out.get(key) is None and hident.get(key) is not None:
                    out[key] = hident.get(key)
        except Exception:
            pass
    return out


def _polygon_mask(points: list[list[float]], width: int, height: int) -> np.ndarray:
    mask = np.zeros((height, width), dtype=np.uint8)
    if len(points) >= 3:
        pts = np.asarray(points, dtype=np.float32)
        if np.isfinite(pts).all():
            pts[:, 0] = np.clip(pts[:, 0], 0, width - 1)
            pts[:, 1] = np.clip(pts[:, 1], 0, height - 1)
            cv2.fillPoly(mask, [pts.astype(np.int32)], 1)
    return mask.astype(bool)


def _pixel_polygon(rep: dict[str, Any], width: int, height: int) -> list[list[float]]:
    if rep.get("geometry_type") != "polygon":
        return []
    points = rep.get("points")
    if not isinstance(points, list) or len(points) < 3:
        return []
    space = rep.get("coordinate_space")
    out: list[list[float]] = []
    for p in points:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            return []
        x, y = float(p[0]), float(p[1])
        if space == "minimap_normalized":
            x, y = x * width, y * height
        elif space != "minimap_pixel":
            return []
        if not math.isfinite(x) or not math.isfinite(y):
            return []
        if not (0 <= x < width and 0 <= y < height):
            return []
        out.append([x, y])
    return out


def collect_existing_candidates(capture: Path, width: int, height: int) -> list[dict[str, Any]]:
    path = capture / "hazard_geometry_v0.json"
    if not path.is_file():
        return []
    bundle = read_json(path)
    out: list[dict[str, Any]] = []
    allowed_sources = {"sam2", "prompt_segmentation", "legacy_bunker_cv", "legacy_cv"}
    for item in bundle.get("objects") or []:
        if not isinstance(item, dict) or item.get("hazard_class") != "bunker":
            continue
        source = item.get("source") or {}
        source_kind = str(source.get("kind") or "unknown")
        if source_kind not in allowed_sources:
            continue
        conf = item.get("confidence") or {}
        geo = conf.get("geometry")
        if geo is not None:
            try:
                if float(geo) < 0.35:
                    continue
            except Exception:
                pass
        for rep in item.get("representations") or []:
            poly = _pixel_polygon(rep, width, height)
            if not poly:
                continue
            mask = _polygon_mask(poly, width, height)
            if int(mask.sum()) < 8:
                continue
            out.append({
                "source": "existing_sam2" if source_kind in {"sam2", "prompt_segmentation"} else "legacy_cv",
                "source_kind": source_kind,
                "source_object_id": source.get("object_id"),
                "semantic_confidence": conf.get("semantic"),
                "geometry_confidence": geo,
                "polygon_pixel": poly,
                "_mask": mask,
            })
            break
    return out


def _box_mask(hazard: hazard_vlm_contract.VlmHazard, width: int, height: int) -> np.ndarray:
    x1, y1, x2, y2 = hazard_vlm_contract.bbox_px(hazard, width, height)
    mask = np.zeros((height, width), dtype=bool)
    mask[max(0, y1):min(height, y2), max(0, x1):min(width, x2)] = True
    return mask


def _semantic_support(mask: np.ndarray, boxes: list[np.ndarray]) -> float:
    area = int(mask.sum())
    if area <= 0 or not boxes:
        return 0.0
    return max(float(np.logical_and(mask, box).sum()) / area for box in boxes)


def _overlap(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    inter = int(np.logical_and(a, b).sum())
    if inter <= 0:
        return 0.0, 0.0
    union = int(np.logical_or(a, b).sum())
    smaller = min(int(a.sum()), int(b.sum()))
    return inter / max(1, union), inter / max(1, smaller)


def dedupe(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rank = {"recall_sam2": 4, "existing_sam2": 3, "legacy_cv": 2}
    ordered = sorted(
        candidates,
        key=lambda x: (
            rank.get(str(x.get("source")), 0),
            float(x.get("geometry_confidence") or 0),
            float(x.get("semantic_confidence") or 0),
            int(np.asarray(x["_mask"]).sum()),
        ),
        reverse=True,
    )
    kept: list[dict[str, Any]] = []
    for candidate in ordered:
        duplicate = False
        for prior in kept:
            iou, cover_small = _overlap(candidate["_mask"], prior["_mask"])
            if iou >= 0.30 or cover_small >= 0.70:
                duplicate = True
                break
        if not duplicate:
            kept.append(candidate)
    return kept


def _serializable_candidate(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k != "_mask"}


def process_capture(
    capture: Path,
    backend: hazard_prompt_segment.PromptSegmentationBackend,
    *,
    model: str,
    timeout_seconds: float,
    force: bool,
) -> dict[str, Any]:
    capture = capture.resolve()
    out_path = capture / "bunker_recall_v1.json"
    if out_path.is_file() and not force:
        return read_json(out_path)

    model_path = capture / "hole_model.json"
    if not model_path.is_file():
        raise RuntimeError("hole_model.json missing")
    hole_model = read_json(model_path)
    image_path, image_policy = step8._semantic_image(capture, hole_model)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"could not read semantic image {image_path}")
    height, width = image.shape[:2]

    contract, meta, raw = call_luna(image_path, model=model, timeout_seconds=timeout_seconds)
    hazards = parse_contract(contract)
    write_json(capture / "bunker_recall_luna_contract_v1.json", contract)
    write_json(capture / "bunker_recall_luna_meta_v1.json", meta)
    write_json(capture / "bunker_recall_luna_raw_v1.json", raw)

    segmented = hazard_prompt_segment.segment_hazards(
        image,
        hazards,
        backend,
        pad_fraction=0.05,
    )
    hazard_prompt_segment.save_artifacts(
        capture,
        image,
        segmented,
        prefix="bunker_recall_sam2_v1",
    )

    semantic_boxes = [_box_mask(h, width, height) for h in hazards]
    recall_candidates: list[dict[str, Any]] = []
    for row in segmented.get("objects") or []:
        if row.get("segmentation_status") != "accepted":
            continue
        poly = [[float(x), float(y)] for x, y in row.get("polygon_px") or []]
        if len(poly) < 3:
            continue
        mask = _polygon_mask(poly, width, height)
        if int(mask.sum()) < 8:
            continue
        recall_candidates.append({
            "source": "recall_sam2",
            "source_kind": "sam2",
            "source_object_id": row.get("hazard_id"),
            "semantic_confidence": row.get("semantic_confidence"),
            "geometry_confidence": row.get("segmentation_quality_score"),
            "polygon_pixel": poly,
            "_mask": mask,
        })

    existing = collect_existing_candidates(capture, width, height)
    accepted_existing: list[dict[str, Any]] = []
    unmatched_existing: list[dict[str, Any]] = []
    for row in existing:
        support = _semantic_support(row["_mask"], semantic_boxes)
        row["semantic_box_support_fraction"] = support
        if row["source"] == "existing_sam2":
            accepted_existing.append(row)
        elif support >= 0.12:
            accepted_existing.append(row)
        else:
            unmatched_existing.append(row)

    accepted = dedupe(recall_candidates + accepted_existing)

    overlay = image.copy()
    for row in unmatched_existing:
        pts = np.asarray(row["polygon_pixel"], dtype=np.int32).reshape((-1, 1, 2))
        cv2.polylines(overlay, [pts], True, (255, 0, 255), 1, cv2.LINE_AA)

    for row in accepted:
        pts = np.asarray(row["polygon_pixel"], dtype=np.int32).reshape((-1, 1, 2))
        color = (255, 255, 0) if row["source"] == "recall_sam2" else (255, 210, 0)
        cv2.polylines(overlay, [pts], True, color, 2, cv2.LINE_AA)

    for h in hazards:
        x1, y1, x2, y2 = hazard_vlm_contract.bbox_px(h, width, height)
        cv2.rectangle(overlay, (x1, y1), (x2, y2), (170, 170, 170), 1)

    overlay_name = "bunker_recall_overlay_v1.png"
    cv2.imwrite(str(capture / overlay_name), overlay)

    payload = {
        "schema_version": SCHEMA_VERSION,
        "identity": identity(capture),
        "source_image": image_path.name,
        "image_policy": image_policy,
        "model": model,
        "sam_model": getattr(backend, "model_id", None),
        "sam_device": getattr(backend, "device", None),
        "semantic_box_count": len(hazards),
        "recall_sam2_accepted_count": len(recall_candidates),
        "existing_precise_candidate_count": len(existing),
        "accepted_unique_bunker_count": len(accepted),
        "unmatched_legacy_evidence_count": len(unmatched_existing),
        "accepted_bunkers": [_serializable_candidate(x) for x in accepted],
        "unmatched_legacy_evidence": [_serializable_candidate(x) for x in unmatched_existing],
        "segmentation_summary": {
            "input_objects": segmented.get("object_count"),
            "accepted_masks": segmented.get("accepted_count"),
            "latency_seconds": segmented.get("latency_seconds"),
        },
        "overlay_artifact": overlay_name,
        "strategy_authority": False,
        "promotion_decision": "none",
        "policy": {
            "visual_truth": "original-gspro-minimap",
            "semantic_discovery": "recall-first-luna-bunker-boxes",
            "exact_edge": "sam2",
            "legacy_requires_recall-box_support": True,
            "dedupe_iou_threshold": 0.30,
            "dedupe_smaller_coverage_threshold": 0.70,
        },
    }
    write_json(out_path, payload)
    return payload


def discover(root: Path) -> list[Path]:
    return sorted(
        {p.parent for p in root.rglob("hole_model.json") if p.parent.name.startswith("tee_capture_")},
        key=lambda p: p.name,
    )


def matches_identity(capture: Path, course_key: str | None, round_id: str | None) -> bool:
    ident = identity(capture)
    if course_key and str(ident.get("course_key") or "").lower() != course_key.lower():
        return False
    if round_id and str(ident.get("round_id") or "") != str(round_id):
        return False
    return True


def review_zip(output_root: Path, rows: list[dict[str, Any]], captures: list[Path]) -> Path:
    stamp = time.strftime("%Y%m%d_%H%M%S")
    path = output_root / f"bunker_recall_review_{stamp}.zip"
    summary = {
        "schema_version": "looper-bunker-recall-review-v1",
        "created_epoch": time.time(),
        "rows": rows,
        "strategy_authority": False,
    }
    summary_path = output_root / "bunker_recall_review_v1.json"
    write_json(summary_path, summary)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(summary_path, arcname=summary_path.name)
        for capture in captures:
            for name in (
                "bunker_recall_overlay_v1.png",
                "bunker_recall_v1.json",
                "bunker_recall_luna_contract_v1.json",
            ):
                src = capture / name
                if src.is_file():
                    zf.write(src, arcname=f"{capture.name}/{name}")
    return path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Recall-first bunker extraction on saved tee minimaps")
    p.add_argument("--output-root", default=str(Path(__file__).resolve().parent / "output"))
    p.add_argument("--capture-dir", action="append", default=[])
    p.add_argument("--course-key")
    p.add_argument("--round-id")
    p.add_argument("--latest", type=int, default=18)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--sam-model", default=DEFAULT_SAM_MODEL)
    p.add_argument("--timeout", type=float, default=60.0)
    p.add_argument("--force", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    output_root = Path(args.output_root).expanduser().resolve()
    captures = [Path(x).expanduser().resolve() for x in args.capture_dir]
    if not captures:
        captures = [
            p for p in discover(output_root)
            if matches_identity(p, args.course_key, args.round_id)
        ]
    if args.latest > 0:
        captures = captures[-args.latest:]
    if not captures:
        print("No matching tee captures found.")
        return 1

    print("Looper Bunker Recall v1")
    print("Original GSPro minimap = visual truth.")
    print("Luna recall-first bunker boxes -> shared SAM2 exact edge -> union/dedupe.")
    print("No GSPro input. Strategy authority OFF.")
    backend = hazard_prompt_segment.Sam2TransformersBackend(args.sam_model, "auto")
    backend._load()
    probe_image = np.zeros((64, 64, 3), dtype=np.uint8)
    probe_image[20:44, 20:44] = 180
    probe = backend.predict(probe_image, [[16.0, 16.0, 48.0, 48.0]])
    if not probe or not probe[0]:
        raise RuntimeError("SAM2 bunker preflight returned no candidate masks")
    first_mask = np.asarray(probe[0][0].mask)
    if first_mask.ndim != 2 or first_mask.size == 0:
        raise RuntimeError(f"SAM2 bunker preflight returned invalid mask shape {first_mask.shape}")
    print(f"SAM2 preflight=OK | model={args.sam_model} | device={backend.device} | mask={first_mask.shape}")

    rows: list[dict[str, Any]] = []
    successes: list[Path] = []
    failures: list[dict[str, str]] = []
    for capture in captures:
        try:
            payload = process_capture(
                capture,
                backend,
                model=args.model,
                timeout_seconds=args.timeout,
                force=args.force,
            )
            rows.append({
                "capture": capture.name,
                "identity": payload.get("identity"),
                "semantic_boxes": payload.get("semantic_box_count"),
                "recall_sam2": payload.get("recall_sam2_accepted_count"),
                "accepted_unique": payload.get("accepted_unique_bunker_count"),
                "unmatched_legacy": payload.get("unmatched_legacy_evidence_count"),
                "overlay": f"{capture.name}/{payload.get('overlay_artifact')}",
            })
            successes.append(capture)
            ident = payload.get("identity") or {}
            print(
                f"H{ident.get('hole_display','?')} bunkers={payload.get('accepted_unique_bunker_count')} "
                f"| Luna boxes={payload.get('semantic_box_count')} "
                f"| SAM={payload.get('recall_sam2_accepted_count')} "
                f"| legacy-only={payload.get('unmatched_legacy_evidence_count')} "
                f"| {capture.name}"
            )
        except Exception as exc:
            failures.append({"capture": capture.name, "error": f"{type(exc).__name__}: {exc}"})
            print(f"{capture.name}: ERROR {type(exc).__name__}: {exc}")

    if successes:
        zip_path = review_zip(output_root, rows, successes)
        print(f"Review ZIP: {zip_path}")
    if failures:
        print("Failures:")
        for row in failures:
            print(f"  {row['capture']}: {row['error']}")
    print("Strategy authority: OFF | Promotion: NONE")
    return 0 if successes and not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
