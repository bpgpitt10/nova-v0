#!/usr/bin/env python3
"""V7 course compiler helpers: make context geometry tactically deterministic.

V6 remains authoritative for route ownership, tee candidates, orientation, and
serialized course geometry. V7 adds one semantic step only:

- natural woods / forest / scrub context is promoted to tactical `deep-rough`;
- explicit golf surfaces keep priority over broad context polygons;
- woods may intentionally overlap ordinary rough so recovery risk wins there;
- water, bunkers, greens, tees, and fairways are carved out of deep-rough.

This keeps the source context for rendering/debugging while giving the decision
engine one deterministic surface classification.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterable

from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.ops import unary_union
from shapely.validation import make_valid

import build_osm_course_package_v4 as v4
import build_osm_course_package_v6 as v6


TACTICAL_CONTEXT_KINDS = ("woods", "scrub")
CONTEXT_BLOCKER_SURFACE_KINDS = (
    "water",
    "penalty",
    "bunker",
    "green",
    "tee",
    "fairway",
)


def _polygon_parts(geometry: Any) -> Iterable[Polygon]:
    if geometry is None or geometry.is_empty:
        return
    if isinstance(geometry, Polygon):
        yield geometry
        return
    if isinstance(geometry, MultiPolygon):
        for part in geometry.geoms:
            yield from _polygon_parts(part)
        return
    if isinstance(geometry, GeometryCollection):
        for part in geometry.geoms:
            yield from _polygon_parts(part)


def _shape_from_serialized(polygons: Any):
    parts: list[Polygon] = []
    if not isinstance(polygons, list):
        return GeometryCollection()
    for ring in polygons:
        if not isinstance(ring, list) or len(ring) < 3:
            continue
        try:
            candidate = make_valid(Polygon(ring))
        except (TypeError, ValueError):
            continue
        parts.extend(part for part in _polygon_parts(candidate) if part.area > 0.05)
    return unary_union(parts) if parts else GeometryCollection()


def _serialized_union(values: Iterable[Any]):
    shapes = [_shape_from_serialized(value) for value in values]
    shapes = [shape for shape in shapes if not shape.is_empty]
    return unary_union(shapes) if shapes else GeometryCollection()


def apply_tactical_surface_semantics(
    model: dict[str, Any],
    simplify_yards: float = v4.DEFAULT_SIMPLIFY_YARDS,
) -> dict[str, Any]:
    """Return a model with a non-overlapping tactical deep-rough surface.

    Woods/scrub are context evidence, not literal GSPro lie labels. They become
    `deep-rough` only after explicit course surfaces are subtracted. Ordinary
    rough is deliberately *not* subtracted: when a rough polygon sits inside
    woods, the tactical answer should be recovery-risk/deep-rough.
    """
    output = deepcopy(model)
    surfaces = dict(output.get("surfaces") or {})
    context = dict(output.get("context") or {})

    context_shape = _serialized_union(
        context.get(kind, []) for kind in TACTICAL_CONTEXT_KINDS
    )
    blocker_shape = _serialized_union(
        surfaces.get(kind, []) for kind in CONTEXT_BLOCKER_SURFACE_KINDS
    )

    deep_rough_shape = context_shape
    if not deep_rough_shape.is_empty and not blocker_shape.is_empty:
        deep_rough_shape = make_valid(deep_rough_shape.difference(blocker_shape))

    deep_rough = v4.serialize_shape(deep_rough_shape, simplify_yards)
    if deep_rough:
        surfaces["deep-rough"] = deep_rough
    else:
        surfaces.pop("deep-rough", None)

    output["surfaces"] = surfaces
    output["semanticSurfacePolicy"] = {
        "version": 1,
        "contextPromotedToDeepRough": list(TACTICAL_CONTEXT_KINDS),
        "deepRoughBlockedBy": list(CONTEXT_BLOCKER_SURFACE_KINDS),
        "roughOverlapAllowed": True,
    }
    return output


def model_for_hole(
    hole_number: int,
    config: dict[str, Any],
    features: list[dict[str, Any]],
    hole_routes: dict[int, dict[str, Any]],
):
    model, diagnostic = v6.model_for_hole(hole_number, config, features, hole_routes)
    selection = config.get("selection") or {}
    simplify_yards = float(selection.get("geometrySimplifyYards", v4.DEFAULT_SIMPLIFY_YARDS))
    model = apply_tactical_surface_semantics(model, simplify_yards)

    deep_rough_count = len((model.get("surfaces") or {}).get("deep-rough", []))
    diagnostic = dict(diagnostic)
    diagnostic["tacticalDeepRoughPolygons"] = deep_rough_count
    diagnostic["tacticalSurfacePolicy"] = (
        "woods/scrub -> deep-rough after subtracting water, penalty, bunker, "
        "green, tee, and fairway; rough overlap intentionally preserved"
    )
    return model, diagnostic
