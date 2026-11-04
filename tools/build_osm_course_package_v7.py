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


TACTICAL_CONTEXT_KINDS = ("woods", "scrub", "native-grass")
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


ROUTE_START_TEE_HALF_WIDTH_YDS = 5.0
ROUTE_START_TEE_HALF_DEPTH_YDS = 4.0


DEFAULT_TEE_SET = "Tee 1"


def _default_tee_set_when_unmapped(model: dict[str, Any]) -> dict[str, Any]:
    """Course-wide tee sets come from Hole 1's mapped tees. When OSM maps no
    tee on Hole 1 (Cabot Cliffs, 11/4) there are none anywhere, the synthetic
    route-start tee below had no tee set to carry, and the course failed the
    import contract ("H1: no teeCandidates"). Use one generic tee set; each
    hole's selected tee (mapped or synthetic) carries it. GSPro's own tees
    replace these once the player's course file is read."""
    contract = dict(model.get("teeSetContract") or {})
    if [label for label in contract.get("teeSets") or [] if label]:
        return model
    model = dict(model)
    contract.update({"version": 1, "sourceHole": 1,
                     "mapping": contract.get("mapping") or "source-identity-then-normalized-back-to-front-position",
                     "teeSets": [DEFAULT_TEE_SET]})
    model["teeSetContract"] = contract
    candidates = [dict(c) for c in model.get("teeCandidates") or []]
    if candidates:
        anchor = next((c for c in candidates if c.get("selectedAnchor")), candidates[0])
        for c in candidates:
            if c is anchor:
                c["teeSet"] = DEFAULT_TEE_SET
                c["teeAliases"] = [DEFAULT_TEE_SET]
            elif c.get("teeSet") == DEFAULT_TEE_SET or DEFAULT_TEE_SET in (c.get("teeAliases") or []):
                c["teeSet"] = None
                c["teeAliases"] = []
        model["teeCandidates"] = candidates
    return model


def _route_start_tee_fallback(model: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """OSM often maps only some tee boxes (Valhalla: 12 golf=tee for 18 holes).
    A hole with no owned tee polygon gets one small, clearly synthetic tee at
    the start of its OSM golf=hole route (the hole frame's origin), carrying
    every course-wide tee set, so the course can still be played. Native GSPro
    positions replace it with the real tee when the player's GKD is available.
    """
    if model.get("teeCandidates"):
        return model, False
    frame = model.get("coordinateFrame") or {}
    if frame.get("origin") != "osm-hole-route-start":
        return model, False
    contract = model.get("teeSetContract") or {}
    tee_sets = [label for label in contract.get("teeSets") or [] if label]
    if not tee_sets:
        return model, False
    greens = (model.get("surfaces") or {}).get("green") or []
    ring = greens[0] if greens else None
    if ring and isinstance(ring[0], (list, tuple)) and isinstance(ring[0][0], (list, tuple)):
        ring = ring[0]
    if ring:
        gx = sum(p[0] for p in ring) / len(ring)
        gy = sum(p[1] for p in ring) / len(ring)
        to_green = (gx * gx + gy * gy) ** 0.5
    else:
        to_green = 0.0
    w, d = ROUTE_START_TEE_HALF_WIDTH_YDS, ROUTE_START_TEE_HALF_DEPTH_YDS
    box = [[-w, -d], [w, -d], [w, d], [-w, d]]
    model = dict(model)
    surfaces = dict(model.get("surfaces") or {})
    surfaces["tee"] = [box]
    model["surfaces"] = surfaces
    model["teeCandidates"] = [{
        "osmId": None,
        "osmType": None,
        "teeSet": tee_sets[0],
        "teeAliases": tee_sets,
        "name": None,
        "ref": None,
        "color": None,
        "label": "Route start (no mapped tee)",
        "sourceTags": {},
        "sourceLatLon": None,
        "coursePoint": [0.0, 0.0],
        "teeToGreenCentroidYards": round(to_green, 1),
        "startPolygonGapYards": 0.0,
        "currentRouteGapYards": 0.0,
        "selectedAnchor": True,
        "synthetic": "osm-hole-route-start",
        "polygons": [box],
    }]
    return model, True


def model_for_hole(
    hole_number: int,
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
):
    model, diagnostic = v6.model_for_hole(hole_number, config, features, hole_routes)
    model = apply_tactical_surface_semantics(model)
    model = _default_tee_set_when_unmapped(model)
    model, synthesized = _route_start_tee_fallback(model)
    if synthesized:
        diagnostic = dict(diagnostic)
        diagnostic["syntheticRouteStartTee"] = True

    deep_rough_count = len((model.get("surfaces") or {}).get("deep-rough", []))
    diagnostic = dict(diagnostic)
    diagnostic["tacticalDeepRoughPolygons"] = deep_rough_count
    diagnostic["tacticalSurfacePolicy"] = (
        "woods/scrub/native grass are preserved and mirrored as deep-rough; runtime precedence "
        "makes water/penalty/bunker/green/tee/fairway beat vegetation, and "
        "vegetation beat ordinary rough"
    )
    return model, diagnostic
