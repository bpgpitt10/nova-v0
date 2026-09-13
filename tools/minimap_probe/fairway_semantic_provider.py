#!/usr/bin/env python3
"""Provider-neutral semantic localization for GSPro fairways.

Luna is the primary provider because it proved more operationally reliable in the
hazard field lab. Gemini remains an optional fallback/benchmark. Both providers
normalize into the same tiny fairway semantic contract; exact geometry remains SAM2.
"""
from __future__ import annotations

import base64
import copy
import json
import os
from pathlib import Path
import time
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

import hazard_vlm_openai as openai_adapter

DEFAULT_PROVIDER = "luna"
DEFAULT_LUNA_MODEL = "gpt-5.6-luna"
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models"
RETRYABLE_HTTP = {408, 409, 429, 500, 502, 503, 504}

SYSTEM = """You analyze a GSPro golf-simulator TEE minimap for Looper.
Your only job is to identify the FAIRWAY belonging to the CURRENT HOLE.

Fairway means the visibly shorter-mown landing/approach surface between the tee area
and the target green. Exclude the putting green itself, tee boxes, rough, trees,
bunkers/sand, water, cart paths, roads, buildings, neighboring-hole fairways, UI,
markers, red penalty lines, and white OB lines.

Return present=false when this hole has no visually distinct fairway (common on many
par 3s), or when you cannot identify it reliably. Prefer precision over guessing.
When present=true, return ONE box covering the whole visible current-hole fairway,
even for a dogleg. A downstream segmenter will trace the exact edge.

For strict structured output, always return four integers for box_2d. When
present=false use [0,0,0,0]. Use an empty string when there is no note. Return only
JSON matching the supplied schema."""

USER = """Identify the current-hole fairway. box_2d is [ymin,xmin,ymax,xmax] in
integer 0-1000 image coordinates. Do not include a polygon or mask."""


def semantic_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "present": {"type": "boolean"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "box_2d": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0, "maximum": 1000},
                "minItems": 4,
                "maxItems": 4,
            },
            "note": {"type": "string"},
        },
        "required": ["present", "confidence", "box_2d", "note"],
        "additionalProperties": False,
    }


def gemini_semantic_schema() -> dict[str, Any]:
    """Gemini responseSchema supports a JSON-Schema subset; strip unsupported keys."""
    schema = copy.deepcopy(semantic_schema())
    schema.pop("additionalProperties", None)
    return schema


def _normalize(result: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise ValueError("fairway semantic response must be an object")
    present = bool(result.get("present"))
    confidence = float(result.get("confidence", 0.0))
    if not 0.0 <= confidence <= 1.0:
        raise ValueError("fairway semantic confidence outside [0,1]")
    box = result.get("box_2d")
    if not isinstance(box, list) or len(box) != 4:
        raise ValueError("fairway semantic box_2d must contain four values")
    vals = [int(v) for v in box]
    if any(v < 0 or v > 1000 for v in vals):
        raise ValueError("fairway semantic box_2d outside [0,1000]")
    note = str(result.get("note") or "").strip() or None

    # Conservative contract repair: both provider prompts explicitly define an empty
    # box as the no-fairway sentinel. If a model contradicts itself by setting
    # present=true while returning that sentinel, treat it as absent rather than
    # crashing the whole replay or inventing geometry.
    if present and (vals[2] <= vals[0] or vals[3] <= vals[1]):
        present = False
        normalized_box: list[int] | None = None
        repair = "provider-returned-present-with-empty-box; treated-as-absent"
        note = f"{note}; {repair}" if note else repair
    elif present:
        normalized_box = vals
    else:
        normalized_box = None

    return {
        "present": present,
        "confidence": confidence,
        "box_2d": normalized_box,
        "note": note,
    }


def _gemini_output(payload: dict[str, Any]) -> dict[str, Any]:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates")
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    text = "".join(str(part.get("text") or "") for part in parts).strip()
    if not text:
        raise RuntimeError("Gemini returned no JSON text")
    return json.loads(text)


def call_luna(
    image_path: str | Path,
    *,
    model: str = DEFAULT_LUNA_MODEL,
    api_key: str | None = None,
    timeout_seconds: float = 60.0,
    retries: int = 3,
) -> tuple[dict[str, Any], dict[str, Any]]:
    path = Path(image_path)
    key = api_key or os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not available in this process")
    image_b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    body: dict[str, Any] = {
        "model": model,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": SYSTEM}]},
            {"role": "user", "content": [
                {
                    "type": "input_image",
                    "image_url": f"data:{openai_adapter._mime(path)};base64,{image_b64}",
                    "detail": "original",
                },
                {"type": "input_text", "text": USER},
            ]},
        ],
        "text": {"format": {
            "type": "json_schema",
            "name": "looper_fairway_semantic",
            "strict": True,
            "schema": semantic_schema(),
        }},
        "reasoning": {"effort": "none"},
        "max_output_tokens": 1024,
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, int(retries))):
        req = urlrequest.Request(
            openai_adapter.API_URL,
            data=json.dumps(body).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=float(timeout_seconds)) as response:
                raw = json.loads(response.read().decode("utf-8"))
            result = _normalize(json.loads(openai_adapter._extract_output_text(raw)))
            return result, {
                "provider": "openai-luna",
                "model": model,
                "latency_seconds": time.perf_counter() - started,
                "response_id": raw.get("id"),
                "response_status": raw.get("status"),
                "usage_metadata": raw.get("usage") or {},
            }
        except urlerror.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", errors="replace")
            except Exception:
                detail = str(exc)
            last = RuntimeError(f"OpenAI HTTP {exc.code}: {detail[:1200]}")
            if exc.code not in RETRYABLE_HTTP or attempt + 1 >= retries:
                raise last
        except urlerror.URLError as exc:
            last = RuntimeError(f"OpenAI network error: {exc}")
            if attempt + 1 >= retries:
                raise last
        time.sleep(min(8.0, 1.25 * (2 ** attempt)))
    raise last or RuntimeError("Luna fairway semantic localization failed")


def call_gemini(
    image_path: str | Path,
    *,
    model: str = DEFAULT_GEMINI_MODEL,
    api_key: str | None = None,
    timeout_seconds: float = 90.0,
    retries: int = 3,
) -> tuple[dict[str, Any], dict[str, Any]]:
    path = Path(image_path)
    key = api_key or os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not available in this process")
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [
            {"inlineData": {
                "mimeType": openai_adapter._mime(path),
                "data": base64.b64encode(path.read_bytes()).decode("ascii"),
            }},
            {"text": USER},
        ]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": gemini_semantic_schema(),
            "maxOutputTokens": 1024,
            "thinkingConfig": {"thinkingLevel": "minimal"},
        },
    }
    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, int(retries))):
        req = urlrequest.Request(
            f"{GEMINI_API_ROOT}/{model}:generateContent",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=float(timeout_seconds)) as response:
                raw = json.loads(response.read().decode("utf-8"))
            result = _normalize(_gemini_output(raw))
            return result, {
                "provider": "google-gemini",
                "model": model,
                "latency_seconds": time.perf_counter() - started,
                "usage_metadata": raw.get("usageMetadata") or {},
            }
        except urlerror.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", errors="replace")
            except Exception:
                detail = str(exc)
            last = RuntimeError(f"Gemini HTTP {exc.code}: {detail[:1200]}")
            if exc.code not in RETRYABLE_HTTP or attempt + 1 >= retries:
                raise last
        except urlerror.URLError as exc:
            last = RuntimeError(f"Gemini network error: {exc}")
            if attempt + 1 >= retries:
                raise last
        time.sleep(min(8.0, 1.5 * (2 ** attempt)))
    raise last or RuntimeError("Gemini fairway semantic localization failed")


def call_provider(
    image_path: str | Path,
    *,
    provider: str,
    model: str | None = None,
    timeout_seconds: float = 60.0,
) -> tuple[dict[str, Any], dict[str, Any]]:
    key = provider.strip().lower()
    if key in {"luna", "openai"}:
        return call_luna(image_path, model=model or DEFAULT_LUNA_MODEL, timeout_seconds=timeout_seconds)
    if key in {"gemini", "google"}:
        return call_gemini(image_path, model=model or DEFAULT_GEMINI_MODEL, timeout_seconds=timeout_seconds)
    raise ValueError(f"Unsupported fairway semantic provider: {provider!r}")


def call_chain(
    image_path: str | Path,
    *,
    provider: str = DEFAULT_PROVIDER,
    model: str | None = None,
    fallback_provider: str | None = "gemini",
    fallback_model: str | None = DEFAULT_GEMINI_MODEL,
    timeout_seconds: float = 60.0,
) -> tuple[dict[str, Any], dict[str, Any]]:
    chain: list[tuple[str, str | None]] = [(provider, model)]
    if fallback_provider and fallback_provider.strip().lower() != provider.strip().lower():
        chain.append((fallback_provider, fallback_model))
    attempts: list[dict[str, Any]] = []
    last: Exception | None = None
    for index, (provider_name, model_name) in enumerate(chain):
        try:
            result, meta = call_provider(
                image_path,
                provider=provider_name,
                model=model_name,
                timeout_seconds=timeout_seconds,
            )
            attempts.append({
                "provider": provider_name,
                "model": meta.get("model") or model_name,
                "status": "complete",
                "latency_seconds": meta.get("latency_seconds"),
            })
            return result, {
                **meta,
                "provider_attempts": attempts,
                "fallback_used": index > 0,
                "fallback_reason": attempts[0].get("error") if index > 0 else None,
                "strategy_authority": False,
            }
        except Exception as exc:
            last = exc
            attempts.append({
                "provider": provider_name,
                "model": model_name,
                "status": "error",
                "error": f"{type(exc).__name__}: {exc}",
            })
    raise RuntimeError(f"All fairway semantic providers failed: {attempts}") from last
