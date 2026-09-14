import { greywolfHole01RenderFixture as source } from '../dev/greywolfHole01RenderFixture'
import type {
  CourseHoleGeometry,
  CoursePolygonYds,
  CourseSurfaceKind,
} from './types'

const OSM_CONFIDENCE = 'high' as const

function osmSurface(
  kind: CourseSurfaceKind,
  polygons: readonly CoursePolygonYds[],
  sourceFeature: string,
) {
  return {
    id: `greywolf-h01-${kind}`,
    kind,
    polygons,
    provenance: {
      source: 'osm' as const,
      sourceFeature,
      confidence: OSM_CONFIDENCE,
      note: 'Cached OSM geometry normalized into selected-tee local yards.',
    },
  }
}

/**
 * Canonical Looper geometry for the currently proven Greywolf Hole 1 package.
 *
 * The runtime contract intentionally does not expose raw OSM elements. Downstream
 * caddie logic consumes local-yard surfaces plus explicit availability/provenance.
 */
export const greywolfHole01Geometry: CourseHoleGeometry = {
  schemaVersion: 'looper-course-geometry-v1',
  courseId: 'greywolf-panorama-bc',
  courseName: source.course,
  location: source.location,
  holeNumber: source.hole,
  par: source.par,
  statedYardageYds: source.yardage,
  coordinateSystem: {
    units: 'yards',
    origin: 'selected-tee',
    xAxis: 'right',
    yAxis: 'forward',
  },
  bounds: source.bounds,
  markers: {
    tee: [source.markers.tee.x, source.markers.tee.y],
    pin: [source.markers.pin.x, source.markers.pin.y],
  },
  surfaces: [
    osmSurface('rough', source.layers.rough, 'golf=rough'),
    osmSurface('fairway', source.layers.fairway, 'golf=fairway'),
    osmSurface('green', source.layers.green, 'golf=green'),
    osmSurface('bunker', source.layers.bunker, 'golf=bunker'),
    osmSurface('water', source.layers.water, 'natural=water / waterway'),
    osmSurface('tee', source.layers.tee, 'golf=tee'),
  ],
  availability: {
    tee: 'available',
    fairway: 'available',
    rough: 'available',
    'deep-rough': 'unavailable',
    green: 'available',
    bunker: 'available',
    water: 'available',
    penalty: 'unavailable',
  },
  registration: {
    status: 'verified',
    method: 'course-wide-similarity',
    sourceCoordinateSystem: 'GSPro [x,z] -> OSM course registration -> selected-tee local yards',
    targetCoordinateSystem: 'looper-hole-local-yards',
    residualsMeters: {
      mean: 2.3293518340982975,
      median: 2.502103872679028,
      max: 4.583575624766918,
      selectedTee: 3.051870036848565,
    },
    validation: {
      testedEndpoints: 40,
      exactSurfaceMatches: 38,
      endpointsWithin2m: 40,
    },
    note: 'Course-wide registration is proven; this cached fixture is already expressed in the local-yard runtime frame.',
  },
  provenance: {
    geometrySource: source.provenance.geometry,
    attribution: source.osm.attribution,
    sourceUrl: source.osm.sourceUrl,
    copyrightUrl: source.osm.copyrightUrl,
    license: source.osm.license,
    licenseUrl: source.osm.licenseUrl,
    fetchedAt: source.osm.snapshot.fetchedAt,
    sourceBaseTimestamp: source.osm.snapshot.osmBaseTimestamp,
    sourceElementIdsComplete: source.osm.snapshot.sourceElementIdsComplete,
    note: source.osm.snapshot.note,
  },
}
