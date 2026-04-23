import type { Club, Shot } from '../types'

type NumberLike = number | null | undefined

export type ResolvedShotFieldSource = 'gspro' | 'ogc' | 'derived' | 'missing'

export type ResolvedPracticeShot = {
  club?: string
  carry?: number
  carrySource?: ResolvedShotFieldSource
  totalDistance?: number
  totalDistanceSource?: ResolvedShotFieldSource
  spin?: number
  spinSource?: ResolvedShotFieldSource
  spinAxis?: number
  spinAxisSource?: ResolvedShotFieldSource
  hla?: number
  hlaSource?: ResolvedShotFieldSource
  vla?: number
  vlaSource?: ResolvedShotFieldSource
  ballSpeed?: number
  ballSpeedSource?: ResolvedShotFieldSource
  peakHeight?: number
  peakHeightSource?: ResolvedShotFieldSource
  offline?: number
  offlineSource?: ResolvedShotFieldSource
  enrichmentRecommended?: boolean
}

export type GsproPracticeFields = {
  club?: string
  carryGame?: number
  carryRaw?: number
  totalDistance?: number
  spin?: number
  spinAxis?: number
  hla?: number
  vla?: number
  ballSpeed?: number
  peakHeight?: number
  offline?: number
}

export type PracticeState = {
  club?: string
  statePhase?: 'pre_shot' | 'post_shot' | 'unknown' | string
  shotCount?: number | null
  resolvedShot?: ResolvedPracticeShot
  gsproFields?: GsproPracticeFields
}

export type ExtractedFrame = {
  frame?: {
    timestampMs?: number
    source?: string
  }
  mode?: 'practice' | string
  practice?: PracticeState | null
}

export type MapGsproExtractedFrameToShotOptions = {
  club: Club
  id?: string
  capturedAt?: string
  source?: Extract<Shot['source'], 'simread'>
}

const isFiniteNumber = (value: NumberLike): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const firstDefinedNumber = (...values: NumberLike[]) =>
  values.find((value): value is number => isFiniteNumber(value))

const resolveCapturedAt = (
  extractedFrame: ExtractedFrame,
  overrideCapturedAt?: string,
) => {
  if (overrideCapturedAt) {
    return overrideCapturedAt
  }

  const timestampMs = extractedFrame.frame?.timestampMs
  if (typeof timestampMs === 'number' && Number.isFinite(timestampMs)) {
    return new Date(timestampMs).toISOString()
  }

  return new Date().toISOString()
}

const resolveShotId = (
  extractedFrame: ExtractedFrame,
  source: Shot['source'],
  overrideId?: string,
) => {
  if (overrideId) {
    return overrideId
  }

  const timestampSeed =
    typeof extractedFrame.frame?.timestampMs === 'number' &&
    Number.isFinite(extractedFrame.frame.timestampMs)
      ? extractedFrame.frame.timestampMs
      : Date.now()

  return `${source}-${timestampSeed}-${crypto.randomUUID()}`
}

export const mapGsproExtractedFrameToShot = (
  extractedFrame: ExtractedFrame,
  options: MapGsproExtractedFrameToShotOptions,
): Shot | null => {
  const practice = extractedFrame.practice
  const resolvedShot = practice?.resolvedShot
  const gsproFields = practice?.gsproFields

  const carryYards = firstDefinedNumber(
    resolvedShot?.carry,
    gsproFields?.carryGame,
    gsproFields?.carryRaw,
  )

  if (!isFiniteNumber(carryYards)) {
    return null
  }

  const totalYards = firstDefinedNumber(
    resolvedShot?.totalDistance,
    gsproFields?.totalDistance,
  )
  const offlineYards = firstDefinedNumber(resolvedShot?.offline, gsproFields?.offline)
  const ballSpeedMph = firstDefinedNumber(
    resolvedShot?.ballSpeed,
    gsproFields?.ballSpeed,
  )
  const verticalLaunchAngleDegrees = firstDefinedNumber(
    resolvedShot?.vla,
    gsproFields?.vla,
  )
  const horizontalLaunchAngleDegrees = firstDefinedNumber(
    resolvedShot?.hla,
    gsproFields?.hla,
  )
  const totalSpinRpm = firstDefinedNumber(resolvedShot?.spin, gsproFields?.spin)
  const spinAxisDegrees = firstDefinedNumber(
    resolvedShot?.spinAxis,
    gsproFields?.spinAxis,
  )
  const source = options.source ?? 'simread'

  return {
    id: resolveShotId(extractedFrame, source, options.id),
    club: options.club,
    included: true,
    capturedAt: resolveCapturedAt(extractedFrame, options.capturedAt),
    enrichmentStatus: 'raw_only',
    ballSpeedMph,
    verticalLaunchAngleDegrees,
    horizontalLaunchAngleDegrees,
    totalSpinRpm,
    spinAxisDegrees,
    carryYards,
    totalYards,
    offlineYards,
    launchAngleDeg: verticalLaunchAngleDegrees,
    spinRpm: totalSpinRpm,
    source,
  }
}
