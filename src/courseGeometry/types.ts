export type CoursePointYds = readonly [rightYds: number, forwardYds: number]
export type CoursePolygonYds = readonly CoursePointYds[]
export type CoursePolylineYds = readonly CoursePointYds[]

export type CourseMapFeatureKind = 'cartpath' | 'road' | 'building' | 'parking'

export type CourseMapFeature = {
  id: string
  kind: CourseMapFeatureKind
  lines?: readonly CoursePolylineYds[]
  polygons?: readonly CoursePolygonYds[]
  provenance: CourseSurfaceProvenance
}

export type CourseSurfaceKind =
  | 'tee'
  | 'fairway'
  | 'rough'
  | 'deep-rough'
  | 'green'
  | 'bunker'
  | 'water'
  | 'penalty'

export type CourseContextKind = 'woods' | 'scrub' | 'grass-context' | 'native-grass' | 'dune-sand' | 'landcover-grass' | 'landcover-woods' | 'landcover-scrub' | 'landcover-bare'

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
  /**
   * LiDAR bare earth; a coarse global model (Copernicus GLO-30, area courses
   * outside LiDAR coverage, corrected to GSPro's heights on the PC); or
   * (GSPro-only courses) scattered heights from GSPro's course file.
   */
  source: 'lidar-dem' | 'global-dem' | 'gspro-heights'
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

export type CourseTeeCandidate = {
  osmId?: string | number
  osmType?: string
  teeSet?: string
  teeAliases?: readonly string[]
  name?: string
  ref?: string
  color?: string
  label?: string
  sourceTags?: Readonly<Record<string, string>>
  sourceLatLon?: readonly [latitude: number, longitude: number]
  coursePoint: CoursePointYds
  teeToGreenCentroidYards?: number
  startPolygonGapYards?: number
  currentRouteGapYards?: number
  selectedAnchor?: boolean
  polygons?: readonly CoursePolygonYds[]
}

export type CourseCoordinateOrigin = 'selected-tee' | 'osm-hole-route-start'

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
    origin: CourseCoordinateOrigin
    xAxis: 'right'
    yAxis: 'forward'
  }
  bounds: CourseGeometryBounds
  viewBounds?: CourseGeometryBounds
  markers: {
    tee: CoursePointYds
    pin?: CoursePointYds
  }
  teeCandidates?: readonly CourseTeeCandidate[]
  surfaces: readonly CourseSurface[]
  contextLayers?: readonly CourseContextLayer[]
  mapFeatures?: readonly CourseMapFeature[]
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
