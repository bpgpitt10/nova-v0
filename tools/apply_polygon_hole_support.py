#!/usr/bin/env python3
"""One-time source patch used on course-importer-cache-v1.

Applies exact OSM multipolygon inner-ring support across the package compiler,
geometry runtime, and the two course renderers. The workflow that invokes this
script removes both the script and itself before committing the resulting
source changes.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one patch target, found {count}")
    target.write_text(text.replace(old, new), encoding="utf-8")


# ---------------------------------------------------------------------------
# Python package compiler: preserve relation inner rings aligned to each outer.
# ---------------------------------------------------------------------------
replace_once(
    "tools/build_osm_course_package.py",
    '''def element_geometries(element: dict[str, Any]) -> list[list[tuple[float, float]]]:
    direct = as_latlon(element.get("geometry") or [])
    if direct:
        return [direct]

    members = element.get("members") or []
    outer_chains: list[list[tuple[float, float]]] = []
    fallback_chains: list[list[tuple[float, float]]] = []
    for member in members:
        geometry = as_latlon(member.get("geometry") or [])
        if not geometry:
            continue
        fallback_chains.append(geometry)
        if member.get("role") in ("outer", ""):
            outer_chains.append(geometry)

    chains = outer_chains or fallback_chains
    return join_chains(chains)
''',
    '''def element_polygon_geometries(element: dict[str, Any]) -> list[dict[str, Any]]:
    """Return relation polygons as aligned outer + inner rings.

    Overpass returns multipolygon member geometry directly. Preserve inner rings
    instead of flattening them away; each inner is assigned to the outer that
    contains its first point. Valid OSM multipolygons guarantee that containment.
    """
    direct = as_latlon(element.get("geometry") or [])
    if direct:
        return [{"outer": direct, "holes": []}]

    members = element.get("members") or []
    outer_chains: list[list[tuple[float, float]]] = []
    inner_chains: list[list[tuple[float, float]]] = []
    fallback_chains: list[list[tuple[float, float]]] = []
    for member in members:
        geometry = as_latlon(member.get("geometry") or [])
        if not geometry:
            continue
        fallback_chains.append(geometry)
        role = member.get("role")
        if role in ("outer", ""):
            outer_chains.append(geometry)
        elif role == "inner":
            inner_chains.append(geometry)

    outers = join_chains(outer_chains or fallback_chains)
    parts = [{"outer": outer, "holes": []} for outer in outers]
    for inner in join_chains(inner_chains):
        if len(inner) < 3:
            continue
        owner = next(
            (part for part in parts if point_in_polygon(inner[0], part["outer"])),
            None,
        )
        if owner is None:
            raise ValueError(
                f"OSM relation {element.get('id')} has an inner ring not contained by any outer ring"
            )
        owner["holes"].append(inner)
    return parts


def element_geometries(element: dict[str, Any]) -> list[list[tuple[float, float]]]:
    return [part["outer"] for part in element_polygon_geometries(element)]
''',
)

replace_once(
    "tools/build_osm_course_package.py",
    '''        geometries = element_geometries(element)
        points = [point for geometry in geometries for point in geometry]
''',
    '''        polygon_parts = element_polygon_geometries(element)
        geometries = [part["outer"] for part in polygon_parts]
        points = [point for geometry in geometries for point in geometry]
''',
)

replace_once(
    "tools/build_osm_course_package.py",
    '''        polygon_geometries = [geometry for geometry in geometries if len(geometry) >= 3]
        if not polygon_geometries:
            continue
        features.append(
            {
                "role": role,
                "kind": kind,
                "osm_type": element.get("type"),
                "osm_id": element.get("id"),
                "source_feature": source_feature(tags, kind),
                "geometries": polygon_geometries,
                "centroid": centroid([point for geometry in polygon_geometries for point in geometry]),
            }
        )
''',
    '''        polygon_parts = [part for part in polygon_parts if len(part["outer"]) >= 3]
        polygon_geometries = [part["outer"] for part in polygon_parts]
        if not polygon_geometries:
            continue
        features.append(
            {
                "role": role,
                "kind": kind,
                "osm_type": element.get("type"),
                "osm_id": element.get("id"),
                "source_feature": source_feature(tags, kind),
                "geometries": polygon_geometries,
                "holes_by_geometry": [part["holes"] for part in polygon_parts],
                "centroid": centroid([point for geometry in polygon_geometries for point in geometry]),
            }
        )
''',
)

replace_once(
    "tools/build_osm_course_package.py",
    '''def forward_range(polygons: list[list[list[float]]]) -> tuple[float, float]:
''',
    '''def serialize_polygon_holes(
    feature: dict[str, Any],
    origin: tuple[float, float],
    forward: tuple[float, float],
    right: tuple[float, float],
) -> list[list[list[list[float]]]]:
    holes_by_geometry = feature.get("holes_by_geometry") or []
    serialized: list[list[list[list[float]]]] = []
    for index, _geometry in enumerate(feature["geometries"]):
        rings: list[list[list[float]]] = []
        source_holes = holes_by_geometry[index] if index < len(holes_by_geometry) else []
        for hole in source_holes:
            local = [to_hole_local(point, origin, forward, right) for point in hole]
            if len(local) >= 3:
                rings.append([[round(x, 3), round(y, 3)] for x, y in local])
        serialized.append(rings)
    return serialized


def forward_range(polygons: list[list[list[float]]]) -> tuple[float, float]:
''',
)

replace_once(
    "tools/build_osm_course_package.py",
    '''    all_polygons: list[list[list[float]]] = []
    source_ids: list[int | str] = []
    source_features: set[str] = set()

    for feature in features:
        polygons = serialize_polygons(feature, origin, forward, right)
        if not polygons or not in_play_window(
            polygons,
            max_forward,
            behind_tolerance,
            past_tolerance,
        ):
            continue
        all_polygons.extend(polygons)
        if feature.get("osm_id") is not None:
            source_ids.append(feature["osm_id"])
        source_features.add(feature["source_feature"])

    if not all_polygons:
        return None

    return {
        "id": f"h{hole_number:02d}-{role}-{kind}",
        "kind": kind,
        "polygons": all_polygons,
        "sourceFeature": " / ".join(sorted(source_features)),
        "sourceIds": source_ids,
        "confidence": "high",
        "note": (
            "Cached OSM playable geometry."
            if role == "surface"
            else "Cached OSM context/obstruction geometry; not promoted to a playable lie."
        ),
    }
''',
    '''    all_polygons: list[list[list[float]]] = []
    all_polygon_holes: list[list[list[list[float]]]] = []
    source_ids: list[int | str] = []
    source_features: set[str] = set()

    for feature in features:
        polygons = serialize_polygons(feature, origin, forward, right)
        polygon_holes = serialize_polygon_holes(feature, origin, forward, right)
        if not polygons or not in_play_window(
            polygons,
            max_forward,
            behind_tolerance,
            past_tolerance,
        ):
            continue
        all_polygons.extend(polygons)
        all_polygon_holes.extend(polygon_holes)
        if feature.get("osm_id") is not None:
            source_ids.append(feature["osm_id"])
        source_features.add(feature["source_feature"])

    if not all_polygons:
        return None

    layer = {
        "id": f"h{hole_number:02d}-{role}-{kind}",
        "kind": kind,
        "polygons": all_polygons,
        "sourceFeature": " / ".join(sorted(source_features)),
        "sourceIds": source_ids,
        "confidence": "high",
        "note": (
            "Cached OSM playable geometry."
            if role == "surface"
            else "Cached OSM context/obstruction geometry; not promoted to a playable lie."
        ),
    }
    if any(all_polygon_holes):
        layer["polygonHoles"] = all_polygon_holes
    return layer
''',
)

# ---------------------------------------------------------------------------
# Runtime types + package parser.
# ---------------------------------------------------------------------------
replace_once(
    "src/courseGeometry/types.ts",
    '''export type CourseSurface = {
  id: string
  kind: CourseSurfaceKind
  polygons: readonly CoursePolygonYds[]
  provenance: CourseSurfaceProvenance
}

export type CourseContextLayer = {
  id: string
  kind: CourseContextKind
  polygons: readonly CoursePolygonYds[]
  provenance: CourseSurfaceProvenance
}
''',
    '''export type CourseSurface = {
  id: string
  kind: CourseSurfaceKind
  polygons: readonly CoursePolygonYds[]
  /** Inner rings aligned by polygon index. Missing/empty entries mean no holes. */
  polygonHoles?: readonly (readonly CoursePolygonYds[])[]
  provenance: CourseSurfaceProvenance
}

export type CourseContextLayer = {
  id: string
  kind: CourseContextKind
  polygons: readonly CoursePolygonYds[]
  /** Inner rings aligned by polygon index. Missing/empty entries mean no holes. */
  polygonHoles?: readonly (readonly CoursePolygonYds[])[]
  provenance: CourseSurfaceProvenance
}
''',
)

replace_once(
    "src/courseGeometry/packagedCourseLoader.ts",
    '''  polygons?: unknown
  sourceFeature?: unknown
''',
    '''  polygons?: unknown
  polygonHoles?: unknown
  sourceFeature?: unknown
''',
)

replace_once(
    "src/courseGeometry/packagedCourseLoader.ts",
    '''const parseSourceIds = (value: unknown): readonly (string | number)[] | undefined => {
''',
    '''const parsePolygonHoles = (
  value: unknown,
  polygonCount: number,
): readonly (readonly CoursePolygonYds[])[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const aligned = Array.from({ length: polygonCount }, (_, index) => parsePolygons(value[index]))
  return aligned.some((holes) => holes.length > 0) ? aligned : undefined
}

const parseSourceIds = (value: unknown): readonly (string | number)[] | undefined => {
''',
)

replace_once(
    "src/courseGeometry/packagedCourseLoader.ts",
    '''    kind,
    polygons: parsedPolygons,
    provenance: {
''',
    '''    kind,
    polygons: parsedPolygons,
    polygonHoles: parsePolygonHoles(raw.polygonHoles, parsedPolygons.length),
    provenance: {
''',
)
# The context parser has the same return shape and the first replacement above
# consumed the surface occurrence; patch the remaining one.
replace_once(
    "src/courseGeometry/packagedCourseLoader.ts",
    '''    kind,
    polygons: parsedPolygons,
    provenance: {
''',
    '''    kind,
    polygons: parsedPolygons,
    polygonHoles: parsePolygonHoles(raw.polygonHoles, parsedPolygons.length),
    provenance: {
''',
)

# ---------------------------------------------------------------------------
# Geometry semantics: holes affect classification, corridor width, and distance.
# ---------------------------------------------------------------------------
replace_once(
    "src/courseGeometry/geometry.ts",
    '''export function classifyPoint(
''',
    '''export function pointInPolygonWithHoles(
  point: CoursePointYds,
  polygon: CoursePolygonYds,
  holes: readonly CoursePolygonYds[] = [],
) {
  return pointInPolygon(point, polygon) && !holes.some((hole) => pointInPolygon(point, hole))
}

export function classifyPoint(
''',
)

replace_once(
    "src/courseGeometry/geometry.ts",
    '''      if (surface.polygons.some((polygon) => pointInPolygon(point, polygon))) {
''',
    '''      if (surface.polygons.some((polygon, index) =>
        pointInPolygonWithHoles(point, polygon, surface.polygonHoles?.[index] ?? []),
      )) {
''',
)

replace_once(
    "src/courseGeometry/geometry.ts",
    '''function horizontalIntervalsForPolygon(polygon: CoursePolygonYds, y: number) {
''',
    '''function subtractIntervals(
  intervals: CrossSectionInterval[],
  cuts: CrossSectionInterval[],
) {
  if (intervals.length === 0 || cuts.length === 0) return intervals
  let remaining = intervals.map((interval) => ({ ...interval }))
  for (const cut of mergeIntervals(cuts)) {
    remaining = remaining.flatMap((interval) => {
      if (cut.max <= interval.min + EPSILON || cut.min >= interval.max - EPSILON) return [interval]
      const pieces: CrossSectionInterval[] = []
      if (cut.min > interval.min + EPSILON) {
        const max = Math.min(cut.min, interval.max)
        pieces.push({ min: interval.min, max, width: max - interval.min, center: (interval.min + max) / 2 })
      }
      if (cut.max < interval.max - EPSILON) {
        const min = Math.max(cut.max, interval.min)
        pieces.push({ min, max: interval.max, width: interval.max - min, center: (min + interval.max) / 2 })
      }
      return pieces
    })
  }
  return remaining
}

function horizontalIntervalsForPolygon(polygon: CoursePolygonYds, y: number) {
''',
)

replace_once(
    "src/courseGeometry/geometry.ts",
    '''    return surface.polygons.flatMap((polygon) => horizontalIntervalsForPolygon(polygon, forwardYds))
''',
    '''    return surface.polygons.flatMap((polygon, index) =>
      subtractIntervals(
        horizontalIntervalsForPolygon(polygon, forwardYds),
        (surface.polygonHoles?.[index] ?? []).flatMap((hole) =>
          horizontalIntervalsForPolygon(hole, forwardYds),
        ),
      ),
    )
''',
)

replace_once(
    "src/courseGeometry/geometry.ts",
    '''    return surface.polygons.flatMap((polygon) => verticalIntervalsForPolygon(polygon, rightYds))
''',
    '''    return surface.polygons.flatMap((polygon, index) =>
      subtractIntervals(
        verticalIntervalsForPolygon(polygon, rightYds),
        (surface.polygonHoles?.[index] ?? []).flatMap((hole) =>
          verticalIntervalsForPolygon(hole, rightYds),
        ),
      ),
    )
''',
)

replace_once(
    "src/courseGeometry/geometry.ts",
    '''    for (const polygon of surface.polygons) {
      found = true
      if (pointInPolygon(point, polygon)) return 0
      minimum = Math.min(minimum, pointToPolygonBoundaryDistance(point, polygon))
    }
''',
    '''    for (let polygonIndex = 0; polygonIndex < surface.polygons.length; polygonIndex += 1) {
      const polygon = surface.polygons[polygonIndex]
      const holes = surface.polygonHoles?.[polygonIndex] ?? []
      found = true
      if (pointInPolygonWithHoles(point, polygon, holes)) return 0
      if (pointInPolygon(point, polygon)) {
        for (const hole of holes) {
          if (pointInPolygon(point, hole)) {
            minimum = Math.min(minimum, pointToPolygonBoundaryDistance(point, hole))
          }
        }
      } else {
        minimum = Math.min(minimum, pointToPolygonBoundaryDistance(point, polygon))
      }
    }
''',
)

replace_once(
    "src/courseGeometry/geometry.ts",
    '''    for (const polygon of surface.polygons) {
      for (let i = 0; i < polygon.length; i += 1) {
        const start = polygon[i]
        const end = polygon[(i + 1) % polygon.length]
        const edgeMinY = Math.min(start[1], end[1])
        const edgeMaxY = Math.max(start[1], end[1])
        if (edgeMaxY < point[1] - forwardBandYds || edgeMinY > point[1] + forwardBandYds) continue

        const closest = closestPointOnSegment(point, start, end)
        const distance = distanceBetween(point, closest)
        if (closest[0] < point[0] - EPSILON) left = Math.min(left, distance)
        else if (closest[0] > point[0] + EPSILON) right = Math.min(right, distance)
        else {
          left = Math.min(left, distance)
          right = Math.min(right, distance)
        }
      }
    }
''',
    '''    for (let polygonIndex = 0; polygonIndex < surface.polygons.length; polygonIndex += 1) {
      const polygon = surface.polygons[polygonIndex]
      const rings = [polygon]
      if (pointInPolygon(point, polygon)) {
        rings.push(...(surface.polygonHoles?.[polygonIndex] ?? []))
      }
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i += 1) {
          const start = ring[i]
          const end = ring[(i + 1) % ring.length]
          const edgeMinY = Math.min(start[1], end[1])
          const edgeMaxY = Math.max(start[1], end[1])
          if (edgeMaxY < point[1] - forwardBandYds || edgeMinY > point[1] + forwardBandYds) continue

          const closest = closestPointOnSegment(point, start, end)
          const distance = distanceBetween(point, closest)
          if (closest[0] < point[0] - EPSILON) left = Math.min(left, distance)
          else if (closest[0] > point[0] + EPSILON) right = Math.min(right, distance)
          else {
            left = Math.min(left, distance)
            right = Math.min(right, distance)
          }
        }
      }
    }
''',
)

# ---------------------------------------------------------------------------
# Canonical renderer: SVG even-odd paths preserve inner rings visually.
# ---------------------------------------------------------------------------
replace_once(
    "src/dev/CourseRenderDevPage.tsx",
    '''  const pathFor = (points: CoursePolygonYds) => {
    if (!transform || points.length === 0) return ''
    return `${points
      .map((point, index) => {
        const [x, y] = transform.point(point)
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(' ')} Z`
  }
''',
    '''  const pathFor = (
    points: CoursePolygonYds,
    holes: readonly CoursePolygonYds[] = [],
  ) => {
    if (!transform || points.length === 0) return ''
    return [points, ...holes]
      .map((ring) => `${ring
        .map((point, index) => {
          const [x, y] = transform.point(point)
          return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
        })
        .join(' ')} Z`)
      .join(' ')
  }
''',
)

replace_once(
    "src/dev/CourseRenderDevPage.tsx",
    '''          <path key={`${surface.id}-${index}`} d={pathFor(polygon)} className={className} />
''',
    '''          <path
            key={`${surface.id}-${index}`}
            d={pathFor(polygon, surface.polygonHoles?.[index] ?? [])}
            className={className}
            fillRule="evenodd"
          />
''',
)

replace_once(
    "src/dev/CourseRenderDevPage.tsx",
    '''          <path key={`${layer.id}-${index}`} d={pathFor(polygon)} className={className} />
''',
    '''          <path
            key={`${layer.id}-${index}`}
            d={pathFor(polygon, layer.polygonHoles?.[index] ?? [])}
            className={className}
            fillRule="evenodd"
          />
''',
)

# ---------------------------------------------------------------------------
# Aim Lab renderer: same exact topology as the decision engine.
# ---------------------------------------------------------------------------
replace_once(
    "src/dev/AimLabPage.tsx",
    '''  const unproject = (x: number, y: number): CoursePointYds => [
    displayBounds.minX + (x - offsetX) / scale,
    displayBounds.minY + (viewSize - y - offsetY) / scale,
  ]

  const ballSvg = project(ball)
''',
    '''  const unproject = (x: number, y: number): CoursePointYds => [
    displayBounds.minX + (x - offsetX) / scale,
    displayBounds.minY + (viewSize - y - offsetY) / scale,
  ]
  const pathForRings = (
    outer: readonly CoursePointYds[],
    holes: readonly (readonly CoursePointYds[])[] = [],
  ) => [outer, ...holes]
    .map((ring) => `${ring.map((point, index) => {
      const [x, y] = project(point)
      return `${index === 0 ? 'M' : 'L'} ${x},${y}`
    }).join(' ')} Z`)
    .join(' ')

  const ballSvg = project(ball)
''',
)

replace_once(
    "src/dev/AimLabPage.tsx",
    '''          layer.polygons.map((polygon, index) => (
            <polygon
              key={`${layer.id}-${index}`}
              className={`aim-context context-${layer.kind}`}
              points={polygon.map((point) => project(point).join(',')).join(' ')}
            />
          )),
''',
    '''          layer.polygons.map((polygon, index) => (
            <path
              key={`${layer.id}-${index}`}
              className={`aim-context context-${layer.kind}`}
              d={pathForRings(polygon, layer.polygonHoles?.[index] ?? [])}
              fillRule="evenodd"
            />
          )),
''',
)

replace_once(
    "src/dev/AimLabPage.tsx",
    '''              surface.polygons.map((polygon, index) => (
                <polygon
                  key={`${surface.id}-${index}`}
                  className={`aim-surface surface-${kind}`}
                  points={polygon.map((point) => project(point).join(',')).join(' ')}
                />
              )),
''',
    '''              surface.polygons.map((polygon, index) => (
                <path
                  key={`${surface.id}-${index}`}
                  className={`aim-surface surface-${kind}`}
                  d={pathForRings(polygon, surface.polygonHoles?.[index] ?? [])}
                  fillRule="evenodd"
                />
              )),
''',
)

print("Applied exact multipolygon inner-ring support.")
