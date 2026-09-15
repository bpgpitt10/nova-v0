export type CoursePointYds = readonly [rightYds: number, forwardYds: number]
export type CoursePolygonYds = readonly CoursePointYds[]

export type CourseSurfaceKind =
  | 'tee'
  | 'fairway'
  | 'rough'
  | 'deep-rough'
  | 'green'
  | 'bunker'
  | 'water'
  | 'penalty'

export type CourseContextKind = 'woods' | 'scrub' | 'grass-context'

export type CourseSurfaceClassification = CourseSurfaceKind | 'unknown'

export type GeometryAvailability = 'available' | 'partial' | 'unavailable'
export type GeometryConfidence = 'high' | 'medium' | 'low' | 'unknown'

export type CourseSurfaceProvenance = {
  source: 'osm' | 'gspro' | 'manual' | 'derived' | 'other'
  sourceFeature?: string
  sourceIds?: readonly (string | number)[]
  confidence: GeometryConfidence
  note?: string
}

export type CourseSurface = {
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

export type CourseContourLine = {
  elevationFt: number
  points: readonly CoursePointYds[]
}

export type CourseTerrainGrid = {
  source: 'lidar-dem'
  sourceResolutionMeters: number
  runtimeSpacingYds: number
  interpolation: 'bilinear'
  minX: number
  minY: number
  width: number
  height: number
  elevationOffsetFt: number
  nodata: number
  values: Uint16Array
  note?: string
}

export type CourseGeometryBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export type CourseRegistration = {
  status: 'verified' | 'approximate' | 'unavailable'
  method?: 'course-wide-similarity' | 'hole-local' | 'manual' | 'other'
  sourceCoordinateSystem?: string
  targetCoordinateSystem: 'looper-hole-local-yards'
  scale?: number
  rotationDeg?: number
  translation?: readonly [number, number]
  residualsMeters?: {
    mean?: number
    median?: number
    max?: number
    selectedTee?: number
  }
  validation?: {
    testedEndpoints?: number
    exactSurfaceMatches?: number
    endpointsWithin2m?: number
  }
  note?: string
}

export type CourseGeometryProvenance = {
  geometrySource: string
  attribution?: string
  sourceUrl?: string
  copyrightUrl?: string
  license?: string
  licenseUrl?: string
  fetchedAt?: string | null
  sourceBaseTimestamp?: string | null
  sourceElementIdsComplete?: boolean
  note?: string
}

export type CourseHoleGeometry = {
  schemaVersion: 'looper-course-geometry-v1'
  courseId: string
  courseName: string
  location?: string
  holeNumber: number
  par?: number
  statedYardageYds?: number
  coordinateSystem: {
    units: 'yards'
    origin: 'selected-tee'
    xAxis: 'right'
    yAxis: 'forward'
  }
  bounds: CourseGeometryBounds
  markers: {
    tee: CoursePointYds
    pin?: CoursePointYds
  }
  surfaces: readonly CourseSurface[]
  contextLayers?: readonly CourseContextLayer[]
  contours?: readonly CourseContourLine[]
  terrain?: CourseTerrainGrid
  availability: Readonly<Record<CourseSurfaceKind, GeometryAvailability>>
  registration: CourseRegistration
  provenance: CourseGeometryProvenance
}

export type TacticalSurfaceSemantics = {
  label: string
  severity: 0 | 1 | 2 | 3 | 4 | 5
  playable: boolean
  preferred: boolean
  countsAsTrouble: boolean
  countsAsPenalty: boolean
}
