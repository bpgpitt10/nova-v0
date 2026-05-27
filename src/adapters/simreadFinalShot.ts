import type { Club, OpenGolfCoachPayload, Shot } from '../types'

export type SimReadRangeDbSource = 'gspro-range-db'

export type SimReadResolvedShotFieldSource = 'gspro' | 'ogc' | 'derived' | 'missing'

export type SimReadResolvedShot = {
  club?: string
  carry?: number
  carrySource?: SimReadResolvedShotFieldSource
  totalDistance?: number
  totalDistanceSource?: SimReadResolvedShotFieldSource
  offline?: number
  offlineSource?: SimReadResolvedShotFieldSource
  ballSpeed?: number
  ballSpeedSource?: SimReadResolvedShotFieldSource
  vla?: number
  vlaSource?: SimReadResolvedShotFieldSource
  hla?: number
  hlaSource?: SimReadResolvedShotFieldSource
  spin?: number
  spinSource?: SimReadResolvedShotFieldSource
  spinAxis?: number
  spinAxisSource?: SimReadResolvedShotFieldSource
  peakHeight?: number
  peakHeightSource?: SimReadResolvedShotFieldSource
  descentAngle?: number
  descentAngleSource?: SimReadResolvedShotFieldSource
  backSpin?: number
  sideSpin?: number
  clubSpeed?: number
  clubPath?: number
  clubAoa?: number
  faceToTarget?: number
  faceToPath?: number
  clubLie?: number
  clubLoft?: number
  dynamicLoft?: number
  closureRate?: number
  clubFaceHImpact?: number
  clubFaceVImpact?: number
  smashFactor?: number
  distToPin?: number
  distanceToPin?: number
  shotName?: string
  shotRanking?: number | string
}

export type SimReadOgcEligibility = {
  callable: boolean
  recommended: boolean
  presentFields: string[]
  missingFields: string[]
}

export type SimReadLayoutSupport = {
  isSupported: boolean
  missingRequiredFields?: string[]
  missingRecommendedFields?: string[]
}

export type SimReadRangeDbTiming = {
  rowId: number
  dateCreated: string | number | null
  emitTimestamp: string
  ageMs?: number
}

export type SimReadFinalShotEvent = {
  event: 'final-shot'
  timestamp?: string
  sequence?: number
  source: SimReadRangeDbSource
  rowId: number
  resolvedShot: SimReadResolvedShot
  visibleFields: string[]
  ogcEligibility: SimReadOgcEligibility | null
  layoutSupport: SimReadLayoutSupport | null
  rangeDbTiming?: SimReadRangeDbTiming
}

export type MapSimReadFinalShotToShotOptions = {
  selectedClub: Club
  selectedShotVariantId: string
  capturedAt?: string
}

const toMetersPerSecond = (milesPerHour: number) => milesPerHour * 0.44704

const isFiniteNumber = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const buildOpenGolfCoachPayload = (
  event: SimReadFinalShotEvent,
): OpenGolfCoachPayload | undefined => {
  const shot = event.resolvedShot
  const payload: OpenGolfCoachPayload = {
    simread: {
      source: event.source,
      rowId: event.rowId,
      reportedClub: shot.club,
      resolvedShot: shot,
      visibleFields: event.visibleFields,
      ogcEligibility: event.ogcEligibility,
      layoutSupport: event.layoutSupport,
      rangeDbTiming: event.rangeDbTiming,
    },
  }

  if (isFiniteNumber(shot.peakHeight)) {
    payload.peak_height_yards = shot.peakHeight
    payload.peakHeight = shot.peakHeight
  }

  if (isFiniteNumber(shot.descentAngle)) {
    payload.descent_angle_degrees = shot.descentAngle
    payload.descentAngle = shot.descentAngle
  }

  if (isFiniteNumber(shot.clubSpeed)) {
    payload.club_speed_mph = shot.clubSpeed
    payload.clubSpeed = shot.clubSpeed
  }

  if (isFiniteNumber(shot.smashFactor)) {
    payload.smash_factor = shot.smashFactor
    payload.smashFactor = shot.smashFactor
  }

  return payload
}

export const mapSimReadFinalShotToShot = (
  event: SimReadFinalShotEvent,
  options: MapSimReadFinalShotToShotOptions,
): Shot => {
  const shot = event.resolvedShot
  const capturedAt =
    options.capturedAt ??
    event.rangeDbTiming?.emitTimestamp ??
    event.timestamp ??
    new Date().toISOString()

  return {
    id: `simread-gspro-range-db-${event.rowId}`,
    club: options.selectedClub,
    included: true,
    capturedAt,
    enrichmentStatus: 'raw_only',
    openGolfCoach: buildOpenGolfCoachPayload(event),
    ballSpeedMetersPerSecond: isFiniteNumber(shot.ballSpeed)
      ? toMetersPerSecond(shot.ballSpeed)
      : undefined,
    verticalLaunchAngleDegrees: shot.vla,
    horizontalLaunchAngleDegrees: shot.hla,
    totalSpinRpm: shot.spin,
    spinAxisDegrees: shot.spinAxis,
    peakHeight: shot.peakHeight,
    descentAngle: shot.descentAngle,
    backSpin: shot.backSpin,
    sideSpin: shot.sideSpin,
    clubSpeed: shot.clubSpeed,
    clubPath: shot.clubPath,
    clubPathDegrees: shot.clubPath,
    clubAoa: shot.clubAoa,
    faceToTarget: shot.faceToTarget,
    faceToTargetDegrees: shot.faceToTarget,
    faceToPath: shot.faceToPath,
    faceToPathDegrees: shot.faceToPath,
    clubLie: shot.clubLie,
    clubLoft: shot.clubLoft,
    dynamicLoft: shot.dynamicLoft,
    closureRate: shot.closureRate,
    clubFaceHImpact: shot.clubFaceHImpact,
    clubFaceVImpact: shot.clubFaceVImpact,
    smashFactor: shot.smashFactor,
    distToPin: shot.distToPin,
    distanceToPin: shot.distanceToPin ?? shot.distToPin,
    ballSpeedMph: shot.ballSpeed,
    carryYards: shot.carry,
    totalYards: shot.totalDistance,
    offlineYards: shot.offline,
    launchAngleDeg: shot.vla,
    spinRpm: shot.spin,
    shotName: shot.shotName,
    shotRanking: shot.shotRanking,
    shotVariantId: options.selectedShotVariantId,
    source: 'simread',
  }
}
