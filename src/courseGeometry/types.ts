export type CoursePoint = readonly [number, number]

export type PolygonGeometry = {
  type: 'Polygon'
  coordinates: CoursePoint[][]
}

export type MultiPolygonGeometry = {
  type: 'MultiPolygon'
  coordinates: CoursePoint[][][]
}

export type LineStringGeometry = {
  type: 'LineString'
  coordinates: CoursePoint[]
}

export type CourseGeometry = PolygonGeometry | MultiPolygonGeometry | LineStringGeometry

export type CourseFeatureKind =
  | 'rough'
  | 'fairway'
  | 'green'
  | 'bunker'
  | 'water'
  | 'tee'
  | 'course_boundary'
  | 'water_context'
  | 'waterway'
  | 'path'

export type Bounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type CourseGeometryFeature = {
  id: string
  osmType: string
  osmId: number
  kind: CourseFeatureKind
  role: 'surface' | 'context'
  sourceTags: Record<string, string>
  geometry: CourseGeometry
  bbox: Bounds
  association?: {
    nearestHole: number
    routeDistanceYards: number
  }
}

export type CourseHole = {
  number: number
  par: {
    value: number | null
    source: 'osm-hole-route-tag' | 'unverified'
    rawOsmValue: string | null
  }
  yardage: {
    gsproTeeToPinYards: number
    osmTeeToGreenCentroidYards: number
    residualYards: number
    lockedEvidenceResidualYards: number
    lockedEvidenceDeltaYards: number
  }
  route: {
    id: string
    osmId: number
    tags: Record<string, string>
    geometry: LineStringGeometry
    bbox: Bounds
  }
  anchors: {
    selectedTee: {
      featureId: string
      osmId: number
      latLon: CoursePoint
      coursePoint: CoursePoint
    }
    targetGreen: {
      featureId: string
      osmId: number
      latLon: CoursePoint
      coursePoint: CoursePoint
    }
    headingDegreesTrue: number
  }
  view: {
    coordinateSystem: string
    clipBounds: Bounds
    featureIds: string[]
    renderPolicy: string
  }
  quality: {
    selectedTeePresent: boolean
    targetGreenPresent: boolean
    staticGeometryReady: boolean
    anchorEvidenceWithinQuarterYard: boolean
    featureCount: number
  }
}

export type CourseGeometryPackage = {
  schemaVersion: 'looper.course_geometry_package.v1'
  generatorVersion: string
  buildFingerprint: string
  course: {
    id: string
    name: string
    location: string
    holeCount: number
  }
  coordinateSystem: {
    originLatLon: CoursePoint
    xAxis: 'east'
    yAxis: 'north'
    units: 'yards'
    projection: string
  }
  bounds: Bounds
  attribution: {
    geometry: string
    snapshotTimestamp: string | null
    role: 'static course geometry'
  }
  registration: {
    validation: {
      tiePointCount: number
      meanResidualYards: number
      medianResidualYards: number
      maxResidualYards: number
      activationGatePassed: boolean
    }
    preservedProof: {
      result: string
      teeMeanResidualYards: number
      teeMaxResidualYards: number
      surfaceStartInside: number
      surfaceStartTested: number
      surfaceEndInside: number
      surfaceEndTested: number
    }
  }
  features: CourseGeometryFeature[]
  holes: CourseHole[]
  compilerDiagnostics: {
    featureCount: number
    routeCount: number
    allHolesStaticGeometryReady: boolean
    allAnchorEvidenceWithinQuarterYard: boolean
  }
  integrationContract: {
    activation: 'render-and-strategy-shadow-only'
    strategyAuthority: false
    dynamicStateStorage: 'outside-course-geometry-package'
    wind: {
      requiredForLiveDecisionSnapshot: true
      source: 'gspro-screen-wind-panel'
      method: 'GSPro top-center HUD OCR'
      fields: ['speed_mph', 'direction_cardinal']
      directionSemantics: string
      failurePolicy: 'unavailable-never-assume-calm'
      embeddedInStaticGeometry: false
    }
  }
}

export type HoleRenderFeature = {
  id: string
  kind: CourseFeatureKind
  polygons: CoursePoint[][][]
}

export type HoleRenderModel = {
  hole: CourseHole
  bounds: Bounds
  tee: CoursePoint
  targetGreen: CoursePoint
  route: CoursePoint[]
  features: HoleRenderFeature[]
  counts: Record<'rough' | 'fairway' | 'green' | 'bunker' | 'water' | 'tee', number>
}
