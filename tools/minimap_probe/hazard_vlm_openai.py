#!/usr/bin/env python3
"""OpenAI vision adapter for Looper hazard semantic localization.

Uses the Responses API over REST; emits the existing provider-neutral
looper-hazard-vlm-v0 contract. Diagnostic only: strategy authority remains off.
"""
from __future__ import annotations

import base64
import copy
import json
import mimetypes
import os
from pathlib import Path
import time
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

import hazard_vlm_contract

API_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-5.6-luna"
RETRYABLE_HTTP = {408, 409, 429, 500, 502, 503, 504}


def _mime(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed in {"image/png", "image/jpeg", "image/webp"}:
        return guessed
    return "image/png" if path.suffix.lower() == ".png" else "image/jpeg"


def _strict_schema() -> dict[str, Any]:
    schema = copy.deepcopy(hazard_vlm_contract.response_schema())
    for field in ("bunkers", "water", "uncertain"):
        schema["properties"][field]["items"]["required"] = [
            "id", "confidence", "bbox_norm", "note"
        ]
    return schema


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


def _parse_contract(payload: dict[str, Any]) -> dict[str, Any]:
    text = _extract_output_text(payload)
    try:
        contract = json.loads(text)
    except Exception as exc:
        raise RuntimeError(f"OpenAI output was not valid JSON: {text[:1200]}") from exc
    hazard_vlm_contract.parse_response(contract)
    return contract


def call_openai_boxes(
    *,
    image_path: str | Path,
    model: str = DEFAULT_MODEL,
    api_key: str | None = None,
    reasoning_effort: str = "none",
    timeout_seconds: float = 60.0,
    retries: int = 3,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    path = Path(image_path)
    key = api_key or os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not available in this process.")

    image_b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    body: dict[str, Any] = {
        "model": model,
        "input": [
            {
                "role": "system",
                "content": [{"type": "input_text", "text": hazard_vlm_contract.SYSTEM_INSTRUCTION}],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_image",
                        "image_url": f"data:{_mime(path)};base64,{image_b64}",
                        "detail": "high",
                    },
                    {"type": "input_text", "text": hazard_vlm_contract.USER_INSTRUCTION},
                ],
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "looper_hazard_vlm",
                "strict": True,
                "schema": _strict_schema(),
            }
        },
        "reasoning": {"effort": reasoning_effort},
        "max_output_tokens": 4096,
    }

    started = time.perf_counter()
    last: Exception | None = None
    for attempt in range(max(1, int(retries))):
        req = urlrequest.Request(
            API_URL,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlrequest.urlopen(req, timeout=float(timeout_seconds)) as response:
                raw = json.loads(response.read().decode("utf-8"))
            contract = _parse_contract(raw)
            hazards = hazard_vlm_contract.parse_response(contract)
            meta = {
                "schema_version": "looper-hazard-openai-boxes-v0",
                "provider": "openai",
                "model": model,
                "reasoning_effort": reasoning_effort,
                "latency_seconds": time.perf_counter() - started,
                "response_id": raw.get("id"),
                "response_status": raw.get("status"),
                "usage_metadata": raw.get("usage") or {},
                "hazard_counts": {
                    "bunker": sum(x.hazard_class == "bunker" for x in hazards),
                    "water": sum(x.hazard_class == "water" for x in hazards),
                    "uncertain": sum(x.hazard_class == "uncertain" for x in hazards),
                },
                "geometry_contract": "semantic-box-only; exact mask delegated to local segmenter",
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
        time.sleep(min(8.0, 1.25 * (2 ** attempt)))
    raise last or RuntimeError("OpenAI box localization failed")
