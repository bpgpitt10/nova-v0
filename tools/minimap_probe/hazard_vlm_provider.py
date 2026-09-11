#!/usr/bin/env python3
"""Provider-neutral router for Looper hazard VLM localization.

Default test order is OpenAI Luna first, then optional Gemini fallback. Every provider
must emit the same looper-hazard-vlm-v0 contract. Diagnostic only.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import hazard_vlm_contract

DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"


def call_provider(
    *,
    image_path: str | Path,
    provider: str,
    model: str | None = None,
    timeout_seconds: float = 60.0,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    key = provider.strip().lower()
    if key in {"openai", "luna"}:
        import hazard_vlm_openai
        result = hazard_vlm_openai.call_openai_boxes(
            image_path=image_path,
            model=model or DEFAULT_OPENAI_MODEL,
            timeout_seconds=timeout_seconds,
        )
    elif key in {"gemini", "google"}:
        import hazard_vlm_gemini_boxes
        result = hazard_vlm_gemini_boxes.call_gemini_boxes(
            image_path=image_path,
            model=model or DEFAULT_GEMINI_MODEL,
            timeout_seconds=timeout_seconds,
        )
    else:
        raise ValueError(f"Unsupported hazard VLM provider: {provider!r}")
    hazard_vlm_contract.parse_response(result[0])
    return result


def call_chain(
    *,
    image_path: str | Path,
    providers: list[tuple[str, str | None]] | None = None,
    timeout_seconds: float = 60.0,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    chain = providers or [("openai", DEFAULT_OPENAI_MODEL)]
    attempts: list[dict[str, Any]] = []
    last: Exception | None = None
    for provider, model in chain:
        try:
            contract, meta, raw = call_provider(
                image_path=image_path,
                provider=provider,
                model=model,
                timeout_seconds=timeout_seconds,
            )
            attempts.append({
                "provider": provider,
                "model": model,
                "status": "complete",
                "latency_seconds": meta.get("latency_seconds"),
            })
            meta = {**meta, "provider_attempts": attempts, "strategy_authority": False}
            return contract, meta, raw, attempts
        except Exception as exc:
            last = exc
            attempts.append({
                "provider": provider,
                "model": model,
                "status": "error",
                "error": f"{type(exc).__name__}: {exc}",
            })
    raise RuntimeError(f"All hazard VLM providers failed: {attempts}") from last
