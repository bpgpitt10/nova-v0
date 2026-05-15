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
  backSpin?: number
  sideSpin?: number
  descentAngle?: number
  spinLoft?: number
  clubSpeed?: number
  clubPathDegrees?: number
  clubPathDeg?: number
  club_path_degrees?: number
  club_path_deg?: number
  club_path?: number
  clubPath?: number
  clubAoa?: number
  clubLie?: number
  clubLoft?: number
  faceToTargetDegrees?: number
  faceToTargetDeg?: number
  face_to_target_degrees?: number
  face_to_target_deg?: number
  face_to_target?: number
  clubFaceToTargetDegrees?: number
  club_face_to_target_degrees?: number
  clubFaceToTarget?: number
  club_face_to_target?: number
  faceToTarget?: number
  faceToPathDegrees?: number
  faceToPathDeg?: number
  face_to_path_degrees?: number
  face_to_path_deg?: number
  face_to_path?: number
  clubFaceToPathDegrees?: number
  club_face_to_path_degrees?: number
  clubFaceToPath?: number
  club_face_to_path?: number
  faceToPath?: number
  closureRate?: number
  horImpact?: number
  vertImpact?: number
  smashFactor?: number
  distanceToPin?: number
  puttSpeed?: number
  shotName?: string
  shotRanking?: number | string
  enrichmentRecommended?: boolean
}

export type GsproPracticeFields = {
  club?: string
  carryGame?: number
  carryRaw?: number
  totalDistance?: number
  offline?: number
  peakHeight?: number
  ballSpeed?: number
  vla?: number
  hla?: number
  descentAngle?: number
  spin?: number
  backSpin?: number
  sideSpin?: number
  spinAxis?: number
  spinLoft?: number
  clubSpeed?: number
  clubPathDegrees?: number
  clubPathDeg?: number
  club_path_degrees?: number
  club_path_deg?: number
  club_path?: number
  clubPath?: number
  clubAoa?: number
  clubLie?: number
  clubLoft?: number
  faceToTargetDegrees?: number
  faceToTargetDeg?: number
  face_to_target_degrees?: number
  face_to_target_deg?: number
  face_to_target?: number
  clubFaceToTargetDegrees?: number
  club_face_to_target_degrees?: number
  clubFaceToTarget?: number
  club_face_to_target?: number
  faceToTarget?: number
  faceToPathDegrees?: number
  faceToPathDeg?: number
  face_to_path_degrees?: number
  face_to_path_deg?: number
  face_to_path?: number
  clubFaceToPathDegrees?: number
  club_face_to_path_degrees?: number
  clubFaceToPath?: number
  club_face_to_path?: number
  faceToPath?: number
  closureRate?: number
  horImpact?: number
  vertImpact?: number
  smashFactor?: number
  distanceToPin?: number
  puttSpeed?: number
  shotName?: string
  shotRanking?: number | string
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

export const SIMREAD_REQUIRED_GSPRO_OUTCOME_FIELDS = [
  'carryYards',
  'totalYards',
  'offlineYards',
] as const

export const SIMREAD_OGC_REQUIRED_INPUT_FIELDS = [
  'ballSpeed',
  'vla',
  'hla',
  'spin',
  'spinAxis',
] as const

export const SIMREAD_OGC_OUTPUT_FIELDS = [
  'shotName',
  'shotRanking',
] as const

export const SIMREAD_GSPRO_DEFINITE_FIELDS = [
  'carryGame',
  'carryRaw',
  'totalDistance',
  'offline',
  'peakHeight',
  'ballSpeed',
  'vla',
  'hla',
  'descentAngle',
  'spin',
  'backSpin',
  'sideSpin',
  'spinAxis',
] as const

export const SIMREAD_LAUNCH_MONITOR_DEPENDENT_FIELDS = [
  'spinLoft',
  'clubSpeed',
  'clubPath',
  'clubAoa',
  'clubLie',
  'clubLoft',
  'faceToTarget',
  'faceToPath',
  'closureRate',
  'horImpact',
  'vertImpact',
  'smashFactor',
  'distanceToPin',
  'puttSpeed',
] as const

type SimreadRequiredGsproOutcomeField =
  (typeof SIMREAD_REQUIRED_GSPRO_OUTCOME_FIELDS)[number]
type SimreadOgcRequiredInputField =
  (typeof SIMREAD_OGC_REQUIRED_INPUT_FIELDS)[number]
type SimreadOgcOutputField = (typeof SIMREAD_OGC_OUTPUT_FIELDS)[number]

export type SimReadEnrichmentStatus =
  | {
      status: 'not_needed'
      reason: 'ogc_interpretation_present'
      presentFields: string[]
      missingFields: []
    }
  | {
      status: 'recommended'
      reason: 'ogc_interpretation_available'
      presentFields: string[]
      missingFields: string[]
      ogcPayload: {
        ball_speed_meters_per_second: number
        vertical_launch_angle_degrees: number
        horizontal_launch_angle_degrees: number
        total_spin_rpm: number
        spin_axis_degrees: number
      }
    }
  | {
      status: 'blocked'
      reason: 'missing_required_gspro_outcome_fields'
      presentFields: string[]
      missingFields: string[]
      userMessage: string
    }
  | {
      status: 'blocked'
      reason: 'missing_required_ogc_inputs'
      presentFields: string[]
      missingFields: string[]
      userMessage: string
    }

export type SimReadShotAdapterResult =
  | {
      shot: Shot
      enrichment: SimReadEnrichmentStatus
    }
  | {
      shot: null
      enrichment: SimReadEnrichmentStatus
    }

export type MapGsproExtractedFrameToShotOptions = {
  club: Club
  id?: string
  capturedAt?: string
  source?: Extract<Shot['source'], 'simread'>
}

type ResolvedShotValues = {
  carryYards?: number
  totalYards?: number
  offlineYards?: number
  ballSpeed?: number
  vla?: number
  hla?: number
  spin?: number
  spinAxis?: number
  shotName?: string
  shotRanking?: number | string
  peakHeight?: number
  backSpin?: number
  sideSpin?: number
  descentAngle?: number
  clubPath?: number
  faceToPath?: number
  faceToTarget?: number
}

const OGC_INPUT_FIELD_LABELS: Record<SimreadOgcRequiredInputField, string> = {
  ballSpeed: 'Ball Speed',
  vla: 'VLA',
  hla: 'HLA',
  spin: 'Total Spin',
  spinAxis: 'Spin Axis',
}

const isFiniteNumber = (value: NumberLike): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const firstDefinedNumber = (...values: NumberLike[]) =>
  values.find((value): value is number => isFiniteNumber(value))

const firstDefinedString = (...values: Array<string | null | undefined>) =>
  values.find((value): value is string => typeof value === 'string' && value.length > 0)

const firstDefinedStringOrNumber = (
  ...values: Array<string | number | null | undefined>
) =>
  values.find(
    (value): value is string | number =>
      typeof value === 'string' || typeof value === 'number',
  )

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

const resolveLooperShotValues = (practice?: PracticeState | null): ResolvedShotValues => {
  const resolvedShot = practice?.resolvedShot
  const gsproFields = practice?.gsproFields

  return {
    carryYards: firstDefinedNumber(
      resolvedShot?.carry,
      gsproFields?.carryGame,
      gsproFields?.carryRaw,
    ),
    totalYards: firstDefinedNumber(
      resolvedShot?.totalDistance,
      gsproFields?.totalDistance,
    ),
    offlineYards: firstDefinedNumber(resolvedShot?.offline, gsproFields?.offline),
    ballSpeed: firstDefinedNumber(resolvedShot?.ballSpeed, gsproFields?.ballSpeed),
    vla: firstDefinedNumber(resolvedShot?.vla, gsproFields?.vla),
    hla: firstDefinedNumber(resolvedShot?.hla, gsproFields?.hla),
    spin: firstDefinedNumber(resolvedShot?.spin, gsproFields?.spin),
    spinAxis: firstDefinedNumber(resolvedShot?.spinAxis, gsproFields?.spinAxis),
    shotName: firstDefinedString(resolvedShot?.shotName, gsproFields?.shotName),
    shotRanking: firstDefinedStringOrNumber(
      resolvedShot?.shotRanking,
      gsproFields?.shotRanking,
    ),
    peakHeight: firstDefinedNumber(resolvedShot?.peakHeight, gsproFields?.peakHeight),
    backSpin: firstDefinedNumber(resolvedShot?.backSpin, gsproFields?.backSpin),
    sideSpin: firstDefinedNumber(resolvedShot?.sideSpin, gsproFields?.sideSpin),
    descentAngle: firstDefinedNumber(
      resolvedShot?.descentAngle,
      gsproFields?.descentAngle,
    ),
    clubPath: firstDefinedNumber(
      resolvedShot?.clubPathDegrees,
      resolvedShot?.club_path_degrees,
      resolvedShot?.clubPathDeg,
      resolvedShot?.club_path_deg,
      resolvedShot?.clubPath,
      resolvedShot?.club_path,
      gsproFields?.clubPathDegrees,
      gsproFields?.club_path_degrees,
      gsproFields?.clubPathDeg,
      gsproFields?.club_path_deg,
      gsproFields?.clubPath,
      gsproFields?.club_path,
    ),
    faceToPath: firstDefinedNumber(
      resolvedShot?.faceToPathDegrees,
      resolvedShot?.face_to_path_degrees,
      resolvedShot?.clubFaceToPathDegrees,
      resolvedShot?.club_face_to_path_degrees,
      resolvedShot?.faceToPathDeg,
      resolvedShot?.face_to_path_deg,
      resolvedShot?.faceToPath,
      resolvedShot?.face_to_path,
      resolvedShot?.clubFaceToPath,
      resolvedShot?.club_face_to_path,
      gsproFields?.faceToPathDegrees,
      gsproFields?.face_to_path_degrees,
      gsproFields?.clubFaceToPathDegrees,
      gsproFields?.club_face_to_path_degrees,
      gsproFields?.faceToPathDeg,
      gsproFields?.face_to_path_deg,
      gsproFields?.faceToPath,
      gsproFields?.face_to_path,
      gsproFields?.clubFaceToPath,
      gsproFields?.club_face_to_path,
    ),
    faceToTarget: firstDefinedNumber(
      resolvedShot?.faceToTargetDegrees,
      resolvedShot?.face_to_target_degrees,
      resolvedShot?.clubFaceToTargetDegrees,
      resolvedShot?.club_face_to_target_degrees,
      resolvedShot?.faceToTargetDeg,
      resolvedShot?.face_to_target_deg,
      resolvedShot?.faceToTarget,
      resolvedShot?.face_to_target,
      resolvedShot?.clubFaceToTarget,
      resolvedShot?.club_face_to_target,
      gsproFields?.faceToTargetDegrees,
      gsproFields?.face_to_target_degrees,
      gsproFields?.clubFaceToTargetDegrees,
      gsproFields?.club_face_to_target_degrees,
      gsproFields?.faceToTargetDeg,
      gsproFields?.face_to_target_deg,
      gsproFields?.faceToTarget,
      gsproFields?.face_to_target,
      gsproFields?.clubFaceToTarget,
      gsproFields?.club_face_to_target,
    ),
  }
}

const getPresentRequiredOutcomeFields = (
  values: ResolvedShotValues,
): SimreadRequiredGsproOutcomeField[] =>
  SIMREAD_REQUIRED_GSPRO_OUTCOME_FIELDS.filter((field) =>
    isFiniteNumber(values[field] as NumberLike),
  )

const getMissingRequiredOutcomeFields = (
  values: ResolvedShotValues,
): SimreadRequiredGsproOutcomeField[] =>
  SIMREAD_REQUIRED_GSPRO_OUTCOME_FIELDS.filter(
    (field) => !getPresentRequiredOutcomeFields(values).includes(field),
  )

const getPresentOgcInputFields = (
  values: ResolvedShotValues,
): SimreadOgcRequiredInputField[] =>
  SIMREAD_OGC_REQUIRED_INPUT_FIELDS.filter((field) =>
    isFiniteNumber(values[field] as NumberLike),
  )

const getMissingOgcInputFields = (
  values: ResolvedShotValues,
): SimreadOgcRequiredInputField[] =>
  SIMREAD_OGC_REQUIRED_INPUT_FIELDS.filter(
    (field) => !getPresentOgcInputFields(values).includes(field),
  )

const getPresentOgcOutputFields = (
  values: ResolvedShotValues,
): SimreadOgcOutputField[] =>
  SIMREAD_OGC_OUTPUT_FIELDS.filter((field) => {
    const value = values[field]
    return typeof value === 'string' || typeof value === 'number'
  })

const getMissingOgcOutputFields = (
  values: ResolvedShotValues,
): SimreadOgcOutputField[] =>
  SIMREAD_OGC_OUTPUT_FIELDS.filter(
    (field) => !getPresentOgcOutputFields(values).includes(field),
  )

const toMetersPerSecond = (milesPerHour: number) =>
  // SimRead/GSPro ball speed is treated as mph here; OGC expects m/s.
  milesPerHour * 0.44704

const buildRecommendedOgcPayload = (values: ResolvedShotValues) => ({
  ball_speed_meters_per_second: toMetersPerSecond(values.ballSpeed as number),
  vertical_launch_angle_degrees: values.vla as number,
  horizontal_launch_angle_degrees: values.hla as number,
  total_spin_rpm: values.spin as number,
  spin_axis_degrees: values.spinAxis as number,
})

const buildMissingOutcomeUserMessage = (
  missingFields: SimreadRequiredGsproOutcomeField[],
) =>
  `Looper needs GSPro to show Carry, Total Distance, and Offline before this shot can be used. Missing: ${missingFields.join(', ')}.`

const buildMissingOgcInputUserMessage = (
  missingFields: SimreadOgcRequiredInputField[],
) =>
  `Looper needs these GSPro tiles visible for interpretation/enrichment: ${missingFields
    .map((field) => OGC_INPUT_FIELD_LABELS[field])
    .join(', ')}.`

const buildShotFromValues = (
  extractedFrame: ExtractedFrame,
  options: MapGsproExtractedFrameToShotOptions,
  values: ResolvedShotValues,
): Shot => {
  const source = options.source ?? 'simread'

  return {
    id: resolveShotId(extractedFrame, source, options.id),
    club: options.club,
    included: true,
    capturedAt: resolveCapturedAt(extractedFrame, options.capturedAt),
    enrichmentStatus: 'raw_only',
    ballSpeedMetersPerSecond: isFiniteNumber(values.ballSpeed)
      ? toMetersPerSecond(values.ballSpeed)
      : undefined,
    verticalLaunchAngleDegrees: values.vla,
    horizontalLaunchAngleDegrees: values.hla,
    totalSpinRpm: values.spin,
    spinAxisDegrees: values.spinAxis,
    clubPathDegrees: values.clubPath,
    faceToPathDegrees: values.faceToPath,
    faceToTargetDegrees: values.faceToTarget,
    ballSpeedMph: values.ballSpeed,
    carryYards: values.carryYards,
    totalYards: values.totalYards,
    offlineYards: values.offlineYards,
    launchAngleDeg: values.vla,
    spinRpm: values.spin,
    shotName: values.shotName,
    shotRanking: values.shotRanking,
    source,
  }
}

export const mapGsproExtractedFrameToShot = (
  extractedFrame: ExtractedFrame,
  options: MapGsproExtractedFrameToShotOptions,
): SimReadShotAdapterResult => {
  const values = resolveLooperShotValues(extractedFrame.practice)
  const presentRequiredOutcomeFields = getPresentRequiredOutcomeFields(values)
  const missingRequiredOutcomeFields = getMissingRequiredOutcomeFields(values)

  if (missingRequiredOutcomeFields.length > 0) {
    const userMessage = buildMissingOutcomeUserMessage(missingRequiredOutcomeFields)
    console.warn(userMessage)

    return {
      shot: null,
      enrichment: {
        status: 'blocked',
        reason: 'missing_required_gspro_outcome_fields',
        presentFields: presentRequiredOutcomeFields,
        missingFields: missingRequiredOutcomeFields,
        userMessage,
      },
    }
  }

  const shot = buildShotFromValues(extractedFrame, options, values)
  const presentOgcInputFields = getPresentOgcInputFields(values)
  const missingOgcInputFields = getMissingOgcInputFields(values)

  if (missingOgcInputFields.length > 0) {
    const userMessage = buildMissingOgcInputUserMessage(missingOgcInputFields)
    console.warn(userMessage)

    return {
      shot,
      enrichment: {
        status: 'blocked',
        reason: 'missing_required_ogc_inputs',
        presentFields: presentOgcInputFields,
        missingFields: missingOgcInputFields,
        userMessage,
      },
    }
  }

  const presentOgcOutputFields = getPresentOgcOutputFields(values)
  const missingOgcOutputFields = getMissingOgcOutputFields(values)

  if (missingOgcOutputFields.length === 0) {
    return {
      shot,
      enrichment: {
        status: 'not_needed',
        reason: 'ogc_interpretation_present',
        presentFields: presentOgcOutputFields,
        missingFields: [],
      },
    }
  }

  return {
    shot,
    enrichment: {
      status: 'recommended',
      reason: 'ogc_interpretation_available',
      presentFields: presentOgcInputFields,
      missingFields: missingOgcOutputFields,
      ogcPayload: buildRecommendedOgcPayload(values),
    },
  }
}
