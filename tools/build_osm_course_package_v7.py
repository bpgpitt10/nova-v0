#!/usr/bin/env python3
"""V7 course compiler helpers: expose vegetation as tactical deep-rough.

V6 remains authoritative for route ownership, tee candidates, orientation, and
serialized course geometry. V7 adds one semantic step only:

- natural woods / forest / scrub context is also exposed as tactical `deep-rough`;
- the original context polygons are preserved unchanged for rendering/debugging;
- no polygon subtraction is attempted, because broad vegetation polygons can
  contain interior golf features and the current serialized package format does
  not encode polygon holes;
- deterministic overlap resolution therefore belongs to runtime surface
  precedence: explicit water/bunker/green/tee/fairway beats vegetation, while
  vegetation beats ordinary rough.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

import build_osm_course_package_v6 as v6


TACTICAL_CONTEXT_KINDS = ("woods", "scrub")
EXPLICIT_SURFACE_PRIORITY = (
    "water",
    "penalty",
    "bunker",
    "green",
    "tee",
    "fairway",
)


def apply_tactical_surface_semantics(model: dict[str, Any]) -> dict[str, Any]:
    """Expose woods/scrub polygons as deep-rough without altering topology.

    The same source polygons intentionally remain in `context`. The tactical
    duplicate is safe because runtime classification resolves overlapping
    surfaces by semantic precedence rather than destructive polygon clipping.
    """
    output = deepcopy(model)
    surfaces = dict(output.get("surfaces") or {})
    context = dict(output.get("context") or {})

    deep_rough: list[Any] = []
    for kind in TACTICAL_CONTEXT_KINDS:
        polygons = context.get(kind, [])
        if isinstance(polygons, list):
            deep_rough.extend(deepcopy(polygons))

    if deep_rough:
        surfaces["deep-rough"] = deep_rough
    else:
        surfaces.pop("deep-rough", None)

    output["surfaces"] = surfaces
    output["semanticSurfacePolicy"] = {
        "version": 2,
        "contextPromotedToDeepRough": list(TACTICAL_CONTEXT_KINDS),
        "explicitSurfacePriority": list(EXPLICIT_SURFACE_PRIORITY),
        "deepRoughBeatsOrdinaryRough": True,
        "topologyStrategy": "preserve-source-polygons-resolve-overlap-at-runtime",
    }
    return output


def model_for_hole(
    hole_number: int,
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
):
    model, diagnostic = v6.model_for_hole(hole_number, config, features, hole_routes)
    model = apply_tactical_surface_semantics(model)

    deep_rough_count = len((model.get("surfaces") or {}).get("deep-rough", []))
    diagnostic = dict(diagnostic)
    diagnostic["tacticalDeepRoughPolygons"] = deep_rough_count
    diagnostic["tacticalSurfacePolicy"] = (
        "woods/scrub are preserved and mirrored as deep-rough; runtime precedence "
        "makes water/penalty/bunker/green/tee/fairway beat vegetation, and "
        "vegetation beat ordinary rough"
    )
    return model, diagnostic
