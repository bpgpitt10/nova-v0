import type { CoursePointYds, CourseSurfaceClassification } from '../courseGeometry/types'

export type LiveStateStatus = 'READY' | 'STALE' | 'UNKNOWN' | 'UNAVAILABLE'

export type LiveField<T> = {
  value: T | null
  status: LiveStateStatus
  source: string | null
  observedAt?: string | null
  ageMs?: number | null
  note?: string
}

export type WorldPoint = { x: number; y: number; z: number }

export type TerrainPlane = {
  elevationFt: number
  gradientRightFtPerFt: number
  gradientForwardFtPerFt: number
  sampleStepYds: number
  source: 'lidar-dem' | 'lidar-contour-proxy'
}

export type WindDirectionConvention = 'from' | 'toward'

export type WindObservation = {
  speedMph: number | null
  directionDegrees: number | null
  convention: WindDirectionConvention | null
  observedAt: string
  source: string
  status: LiveStateStatus
  note?: string
}

export type TeeSelection = {
  label: string
  coursePoint: CoursePointYds | null
  confidence: 'high' | 'medium' | 'low' | 'unknown'
}

export type LiveShotState = {
  revision: number
  assembledAt: string
  overallStatus: LiveStateStatus
  game: {
    course: LiveField<string>
    hole: LiveField<number>
    shotNumber: LiveField<number>
    ballPositionWorld: LiveField<WorldPoint>
    ballPositionLocalYds: LiveField<CoursePointYds>
    startingSurface: LiveField<string>
    targetPositionWorld: LiveField<WorldPoint>
    targetPositionLocalYds: LiveField<CoursePointYds>
    targetDistanceYards: LiveField<number>
    aimBearingDegrees: LiveField<number>
  }
  course: {
    matchedCoordinate: LiveField<CoursePointYds>
    groundElevationFt: LiveField<number>
    terrainPlane: LiveField<TerrainPlane>
    uphillDownhillLieDegrees: LiveField<number>
    leftRightLieDegrees: LiveField<number>
    surface: LiveField<CourseSurfaceClassification>
    targetElevationChangeFt: LiveField<number>
    registrationResidualMeters: LiveField<number>
  }
  wind: {
    speedMph: LiveField<number>
    directionDegrees: LiveField<number>
    directionConvention: LiveField<WindDirectionConvention>
    helpingHurtingMph: LiveField<number>
    leftRightMph: LiveField<number>
  }
  tee: {
    selection: LiveField<TeeSelection>
    detectionMethod: 'position-match' | 'round-selection' | 'unknown'
  }
  sources: {
    currentRound: LiveField<string>
    outputLog: LiveField<string>
    registration: LiveField<string>
    lidar: LiveField<string>
    windOcr: LiveField<string>
  }
  decision: {
    playerProfileId: string | null
    recommendedClub: string | null
    selectedClub: string | null
    expectedCarryYards: number | null
    intendedAimPoint: CoursePointYds | null
  }
}
