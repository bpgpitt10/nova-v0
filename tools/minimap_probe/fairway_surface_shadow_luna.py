#!/usr/bin/env python3
"""Luna-first entry point for the existing fairway shadow extractor.

Keeps fairway_surface_shadow_v0 output unchanged while replacing only semantic
provider selection: OpenAI Luna first, Gemini fallback, then the existing SAM2 and
QA stages. No GSPro actuation and no strategy authority.
"""
from __future__ import annotations

from pathlib import Path

import fairway_semantic_provider as semantic_provider
import fairway_surface_shadow as fairway


def _semantic_locator(
    image_path: Path,
    *,
    model: str,
    api_key: str | None = None,
    timeout_seconds: float = 90.0,
    retries: int = 3,
):
    # api_key/retries are retained in the callable shape expected by the original
    # extractor. Provider-specific credentials continue to come from OPENAI_API_KEY
    # and GEMINI_API_KEY, matching the hazard field-lab adapters.
    del api_key, retries
    return semantic_provider.call_chain(
        image_path,
        provider="luna",
        model=model or semantic_provider.DEFAULT_LUNA_MODEL,
        fallback_provider="gemini",
        fallback_model=semantic_provider.DEFAULT_GEMINI_MODEL,
        timeout_seconds=timeout_seconds,
    )


def main() -> int:
    fairway.DEFAULT_MODEL = semantic_provider.DEFAULT_LUNA_MODEL
    fairway.call_semantic_locator = _semantic_locator
    return fairway.main()


if __name__ == "__main__":
    raise SystemExit(main())
