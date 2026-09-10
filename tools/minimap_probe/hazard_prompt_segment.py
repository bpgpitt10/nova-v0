#!/usr/bin/env python3
"""Promptable local segmentation for VLM-localized GSPro hazards.

The semantic model decides WHAT a region is. This module decides the visible pixel
shape inside/around that semantic box. It is intentionally provider-neutral and all
results remain shadow-only / strategy_authority=False.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import time
from typing import Any, Protocol

import cv2
import numpy as np

import hazard_vlm_contract

SCHEMA_VERSION = "looper-hazard-prompt-segment-v0"
DEFAULT_SAM2_MODEL = "facebook/sam2.1-hiera-tiny"


@dataclass
class RawMaskPrediction:
    mask: np.ndarray
    model_score: float | None = None
    backend_note: str | None = None


class PromptSegmentationBackend(Protocol):
    name: str
    model_id: str
    device: str

    def predict(self, image_rgb: np.ndarray, boxes_xyxy: list[list[float]]) -> list[list[RawMaskPrediction]]:
        """Return zero or more mask candidates for every input box."""


class Sam2TransformersBackend:
    """SAM2 through Hugging Face Transformers; avoids Meta's compiled SAM2 extension.

    This is a field-lab backend, not a commitment to the production web runtime.
    The model and processor are loaded lazily so unit tests do not require torch.
    """

    name = "sam2-transformers"

    def __init__(self, model_id: str = DEFAULT_SAM2_MODEL, device: str = "auto") -> None:
        self.model_id = model_id
        self.device = device
        self._torch = None
        self._processor = None
        self._model = None

    def _load(self) -> None:
        if self._model is not None:
            return
        try:
            import torch
            from transformers import Sam2Model, Sam2Processor
        except Exception as exc:
            raise RuntimeError(
                "SAM2 Transformers dependencies are unavailable. Run the Step 6 Windows launcher first."
            ) from exc
        if self.device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            device = self.device
        self.device = device
        self._torch = torch
        self._processor = Sam2Processor.from_pretrained(self.model_id)
        self._model = Sam2Model.from_pretrained(self.model_id).to(device)
        self._model.eval()

    @staticmethod
    def _score_array(scores: Any) -> np.ndarray:
        try:
            arr = scores.detach().float().cpu().numpy()
        except Exception:
            arr = np.asarray(scores)
        return np.asarray(arr, dtype=np.float32)

    @staticmethod
    def _mask_groups(masks: Any, object_count: int) -> list[np.ndarray]:
        try:
            arr = masks.detach().cpu().numpy()
        except Exception:
            arr = np.asarray(masks)
        arr = np.asarray(arr)
        # Common post-process shapes are [objects, masks, H, W] or [1, objects, masks, H, W].
        while arr.ndim > 4 and arr.shape[0] == 1:
            arr = arr[0]
        if arr.ndim == 2:
            arr = arr[None, None, :, :]
        elif arr.ndim == 3:
            if object_count == 1:
                arr = arr[None, :, :, :]
            elif arr.shape[0] == object_count:
                arr = arr[:, None, :, :]
            else:
                raise RuntimeError(f"Unexpected SAM2 mask shape {arr.shape} for {object_count} boxes")
        if arr.ndim != 4:
            raise RuntimeError(f"Unexpected SAM2 mask shape {arr.shape}")
        if arr.shape[0] != object_count and arr.shape[1] == object_count:
            arr = np.transpose(arr, (1, 0, 2, 3))
        if arr.shape[0] != object_count:
            raise RuntimeError(f"SAM2 returned {arr.shape[0]} object groups for {object_count} boxes")
        return [arr[i] for i in range(object_count)]

    @staticmethod
    def _scores_by_object(scores: np.ndarray, object_count: int, candidate_counts: list[int]) -> list[list[float | None]]:
        arr = scores
        while arr.ndim > 2 and arr.shape[0] == 1:
            arr = arr[0]
        if arr.ndim == 1:
            if object_count == 1:
                arr = arr[None, :]
            elif arr.shape[0] == object_count:
                arr = arr[:, None]
        if arr.ndim == 2 and arr.shape[0] != object_count and arr.shape[1] == object_count:
            arr = arr.T
        out: list[list[float | None]] = []
        for i, count in enumerate(candidate_counts):
            if arr.ndim == 2 and i < arr.shape[0]:
                row = [float(x) for x in arr[i].ravel()[:count]]
            else:
                row = []
            out.append(row + [None] * max(0, count - len(row)))
        return out

    def predict(self, image_rgb: np.ndarray, boxes_xyxy: list[list[float]]) -> list[list[RawMaskPrediction]]:
        self._load()
        assert self._torch is not None and self._processor is not None and self._model is not None
        if not boxes_xyxy:
            return []
        from PIL import Image

        image = Image.fromarray(np.asarray(image_rgb, dtype=np.uint8), mode="RGB")
        inputs = self._processor(images=image, input_boxes=[boxes_xyxy], return_tensors="pt").to(self.device)
        with self._torch.no_grad():
            outputs = self._model(**inputs, multimask_output=True)
        masks = self._processor.post_process_masks(outputs.pred_masks.cpu(), inputs["original_sizes"])[0]
        groups = self._mask_groups(masks, len(boxes_xyxy))
        score_rows = self._scores_by_object(self._score_array(outputs.iou_scores), len(boxes_xyxy), [len(g) for g in groups])
        result: list[list[RawMaskPrediction]] = []
        for group, scores in zip(groups, score_rows):
            rows = []
            for mask, score in zip(group, scores):
                rows.append(RawMaskPrediction(mask=np.asarray(mask) > 0, model_score=score))
            result.append(rows)
        return result


def bbox_px(hazard: hazard_vlm_contract.VlmHazard, width: int, height: int, pad_fraction: float = 0.08) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = hazard_vlm_contract.bbox_px(hazard, width, height)
    dx = max(2, round((x2 - x1) * max(0.0, pad_fraction)))
    dy = max(2, round((y2 - y1) * max(0.0, pad_fraction)))
    return max(0, x1 - dx), max(0, y1 - dy), min(width, x2 + dx), min(height, y2 + dy)


def _largest_relevant_component(mask: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    binary = (np.asarray(mask) > 0).astype(np.uint8)
    if binary.ndim != 2:
        raise ValueError("Mask must be 2D")
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if count <= 1:
        return binary.astype(bool)
    x1, y1, x2, y2 = box
    bx = (x1 + x2 - 1) / 2.0
    by = (y1 + y2 - 1) / 2.0
    best_label = None
    best_score = -1.0
    for label in range(1, count):
        component = labels == label
        inside = int(component[y1:y2, x1:x2].sum())
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area <= 0 or inside <= 0:
            continue
        cx, cy = centroids[label]
        distance = math.hypot(cx - bx, cy - by)
        diag = max(1.0, math.hypot(x2 - x1, y2 - y1))
        score = inside + 0.20 * area - 0.10 * area * min(3.0, distance / diag)
        if score > best_score:
            best_score = score
            best_label = label
    if best_label is None:
        return np.zeros_like(binary, dtype=bool)
    return labels == best_label


def _contour(mask: np.ndarray) -> list[list[int]]:
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    perimeter = cv2.arcLength(contour, True)
    epsilon = max(0.75, perimeter * 0.003)
    approx = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
    return [[int(x), int(y)] for x, y in approx[:2000]]


def _metrics(mask: np.ndarray, box: tuple[int, int, int, int], image_shape: tuple[int, int]) -> dict[str, Any]:
    h, w = image_shape
    x1, y1, x2, y2 = box
    area = int(mask.sum())
    box_area = max(1, (x2 - x1) * (y2 - y1))
    inside = int(mask[y1:y2, x1:x2].sum())
    ys, xs = np.where(mask)
    touches = bool(area and (xs.min() == 0 or ys.min() == 0 or xs.max() == w - 1 or ys.max() == h - 1))
    return {
        "mask_area_px": area,
        "image_fraction": area / max(1, h * w),
        "box_area_px": box_area,
        "mask_to_box_area_ratio": area / box_area,
        "mask_pixels_inside_prompt_box": inside,
        "mask_fraction_inside_prompt_box": inside / max(1, area),
        "prompt_box_fill_fraction": inside / box_area,
        "touches_image_edge": touches,
    }


def _quality(metrics: dict[str, Any], model_score: float | None) -> tuple[float, list[str]]:
    reasons: list[str] = []
    area = metrics["mask_area_px"]
    image_fraction = metrics["image_fraction"]
    ratio = metrics["mask_to_box_area_ratio"]
    inside = metrics["mask_fraction_inside_prompt_box"]
    if area < 6:
        reasons.append("too-few-pixels")
    if image_fraction > 0.50:
        reasons.append("implausibly-large-image-fraction")
    if ratio > 8.0:
        reasons.append("mask-far-larger-than-prompt-box")
    if ratio < 0.01:
        reasons.append("mask-far-smaller-than-prompt-box")
    if inside < 0.08:
        reasons.append("little-overlap-with-prompt-box")
    score = 0.0 if model_score is None or not math.isfinite(float(model_score)) else float(model_score)
    score += 0.35 * min(1.0, inside)
    score += 0.15 * min(1.0, metrics["prompt_box_fill_fraction"] * 2.0)
    score -= 0.25 * len(reasons)
    return score, reasons


def segment_hazards(
    image_bgr: np.ndarray,
    hazards: list[hazard_vlm_contract.VlmHazard],
    backend: PromptSegmentationBackend,
    *,
    pad_fraction: float = 0.08,
) -> dict[str, Any]:
    started = time.perf_counter()
    h, w = image_bgr.shape[:2]
    boxes = [bbox_px(hazard, w, h, pad_fraction) for hazard in hazards]
    raw = backend.predict(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB), [list(box) for box in boxes]) if hazards else []
    objects = []
    accepted_masks: dict[str, np.ndarray] = {}

    for i, hazard in enumerate(hazards):
        candidates = raw[i] if i < len(raw) else []
        scored = []
        for j, prediction in enumerate(candidates):
            mask = np.asarray(prediction.mask) > 0
            if mask.shape != (h, w):
                mask = cv2.resize(mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
            mask = _largest_relevant_component(mask, boxes[i])
            metrics = _metrics(mask, boxes[i], (h, w))
            quality, reasons = _quality(metrics, prediction.model_score)
            scored.append((quality, j, mask, metrics, reasons, prediction))
        scored.sort(key=lambda x: x[0], reverse=True)
        best = scored[0] if scored else None
        if best:
            quality, chosen_index, mask, metrics, reasons, prediction = best
            polygon = _contour(mask)
            accepted = bool(mask.any() and not reasons)
        else:
            quality, chosen_index, mask, metrics, reasons, prediction, polygon, accepted = None, None, np.zeros((h, w), bool), {}, ["backend-returned-no-mask"], None, [], False

        if accepted:
            accepted_masks[hazard.hazard_id] = mask
        polygon_norm = [[x / w, y / h] for x, y in polygon]
        objects.append({
            "hazard_id": hazard.hazard_id,
            "hazard_class": hazard.hazard_class,
            "semantic_confidence": hazard.confidence,
            "semantic_bbox_norm": list(hazard.bbox_norm),
            "prompt_box_px": list(boxes[i]),
            "segmentation_status": "accepted" if accepted else "rejected",
            "segmentation_quality_score": quality,
            "segmentation_reject_reasons": reasons,
            "model_mask_score": None if prediction is None else prediction.model_score,
            "candidate_mask_count": len(candidates),
            "chosen_candidate_index": chosen_index,
            "metrics": metrics,
            "polygon_px": polygon,
            "polygon_norm": polygon_norm,
            "strategy_authority": False,
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "backend": getattr(backend, "name", type(backend).__name__),
        "model_id": getattr(backend, "model_id", None),
        "device": getattr(backend, "device", None),
        "latency_seconds": time.perf_counter() - started,
        "object_count": len(objects),
        "accepted_count": sum(x["segmentation_status"] == "accepted" for x in objects),
        "objects": objects,
        "_accepted_masks": accepted_masks,
        "strategy_authority": False,
    }


def draw_overlay(image_bgr: np.ndarray, payload: dict[str, Any], masks: dict[str, np.ndarray] | None = None) -> np.ndarray:
    canvas = image_bgr.copy()
    masks = masks or payload.get("_accepted_masks") or {}
    for row in payload.get("objects", []):
        hid = row["hazard_id"]
        mask = masks.get(hid)
        if mask is not None and np.any(mask):
            contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(canvas, contours, -1, (255, 255, 255), 2, cv2.LINE_AA)
        x1, y1, x2, y2 = row["prompt_box_px"]
        cv2.rectangle(canvas, (x1, y1), (x2, y2), (190, 190, 190), 1)
        label = f"{row['hazard_class'][0].upper()} {row['semantic_confidence']:.2f} {row['segmentation_status']}"
        cv2.putText(canvas, label, (max(2, x1), max(14, y1 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.36, (255, 255, 255), 1, cv2.LINE_AA)
    return canvas


def save_artifacts(capture_dir: str | Path, image_bgr: np.ndarray, payload: dict[str, Any], prefix: str = "hazard_sam2") -> dict[str, str]:
    capture = Path(capture_dir)
    masks: dict[str, np.ndarray] = payload.pop("_accepted_masks", {})
    mask_dir = capture / f"{prefix}_masks_v0"
    mask_dir.mkdir(parents=True, exist_ok=True)
    artifacts: dict[str, str] = {}
    for hazard_id, mask in masks.items():
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in hazard_id)
        path = mask_dir / f"{safe}.png"
        cv2.imwrite(str(path), mask.astype(np.uint8) * 255)
    overlay = capture / f"{prefix}_overlay_v0.png"
    cv2.imwrite(str(overlay), draw_overlay(image_bgr, payload, masks))
    result = capture / f"{prefix}_v0.json"
    result.write_text(__import__("json").dumps(payload, indent=2), encoding="utf-8")
    artifacts["result"] = result.name
    artifacts["overlay"] = overlay.name
    artifacts["mask_dir"] = mask_dir.name
    return artifacts
