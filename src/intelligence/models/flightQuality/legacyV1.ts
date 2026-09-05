import type { IntelligenceResult } from '../../contracts'
import type { PerformanceDriverInput, PerformanceDriverInputShot } from '../../input'
import { weightedAverage, weightedMedian } from '../../math/weighted'
import {
  flightQualityLegacyV1Config,
  type FlightQualityConfig,
} from './config'

const MODEL_ID = 'performance.flight_quality'
const MODEL_VERSION = 'legacy-v1'

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value))

const oneDecimal = (value: number) => Number(value.toFixed(1))

type FlightField = {
  key: 'launch' | 'spin' | 'descent' | 'spinAxis'
  label: string
  baseWeight: number
  valueAccessor: (shot: PerformanceDriverInputShot) => number | null
}

export const calculateFlightQualityLegacyV1 = (
  input: PerformanceDriverInput,
  config: FlightQualityConfig = flightQualityLegacyV1Config,
): IntelligenceResult<number | null> => {
  const includedShots = input.shots.filter(
    (shot) => shot.included && shot.analysisWeight > 0,
  )

  const fields: FlightField[] = [
    { key: 'descent', label: 'descent', baseWeight: config.fieldWeights.descent, valueAccessor: (shot) => shot.descentAngleDegrees },
    { key: 'spin', label: 'spin', baseWeight: config.fieldWeights.spin, valueAccessor: (shot) => shot.totalSpinRpm },
    { key: 'spinAxis', label: 'spin axis', baseWeight: config.fieldWeights.spinAxis, valueAccessor: (shot) => shot.spinAxisDegrees },
    { key: 'launch', label: 'launch', baseWeight: config.fieldWeights.launch, valueAccessor: (shot) => shot.verticalLaunchAngleDegrees },
  ]

  const qualifiedShotCount = includedShots.filter((shot) =>
    fields.some((field) => typeof field.valueAccessor(shot) === 'number'),
  ).length

  const fieldScores = fields.flatMap((field) => {
    const fieldShots = includedShots.filter(
      (shot) => typeof field.valueAccessor(shot) === 'number',
    )
    if (fieldShots.length === 0) return []

    const values = fieldShots.map((shot) => field.valueAccessor(shot) as number)
    const weights = fieldShots.map((shot) => shot.analysisWeight)
    const center = weightedMedian(values, weights)
    if (typeof center !== 'number') return []

    const deviation = weightedAverage(
      values.map((value) => Math.abs(value - center)),
      weights,
    )
    if (typeof deviation !== 'number') return []

    const denominator = (() => {
      switch (field.key) {
        case 'launch': return Math.max(Math.abs(center), config.denominatorFloors.launch)
        case 'spin': return Math.max(Math.abs(center), config.denominatorFloors.spin)
        case 'descent': return Math.max(Math.abs(center), config.denominatorFloors.descent)
        case 'spinAxis': {
          const absMedian = weightedMedian(values.map((value) => Math.abs(value)), weights)
          return Math.max(absMedian ?? 0, config.denominatorFloors.spinAxisAbsoluteMedian)
        }
      }
    })()

    const relativeDeviation = deviation / denominator
    const score = clamp(100 - 100 * relativeDeviation)
    return [{ key: field.key, label: field.label, baseWeight: field.baseWeight, center, deviation, denominator, relativeDeviation, score }]
  })

  const coreFieldsPresent = fieldScores.length
  const sessionCount = new Set(
    includedShots.map((shot) => shot.sessionId).filter((id): id is string => typeof id === 'string'),
  ).size

  if (qualifiedShotCount < config.minimumQualifiedShots || coreFieldsPresent < config.minimumCoreFields) {
    return {
      modelId: MODEL_ID,
      modelVersion: MODEL_VERSION,
      value: null,
      explanation: 'Insufficient flight-profile data',
      evidence: {
        shotCount: qualifiedShotCount,
        sessionCount,
        warnings: ['Insufficient flight-profile data'],
      },
      trace: [
        {
          id: 'flight-evidence',
          label: 'Flight evidence',
          description: 'Legacy Flight Quality requires enough shots with flight data and enough distinct scored fields.',
          values: { qualifiedShots: qualifiedShotCount, coreFieldsPresent, minimumQualifiedShots: config.minimumQualifiedShots, minimumCoreFields: config.minimumCoreFields },
        },
      ],
    }
  }

  const activeWeightTotal = fieldScores.reduce((sum, field) => sum + field.baseWeight, 0)
  const flightQualityBase = activeWeightTotal > 0
    ? fieldScores.reduce((sum, field) => sum + field.score * (field.baseWeight / activeWeightTotal), 0)
    : 0

  const availabilityAdjustment =
    coreFieldsPresent === 4
      ? config.availabilityAdjustment.fourFields
      : coreFieldsPresent === 3
        ? config.availabilityAdjustment.threeFields
        : config.availabilityAdjustment.twoFields

  const score = clamp(Math.round(flightQualityBase + availabilityAdjustment))
  const provisionalPrefix =
    qualifiedShotCount >= config.minimumQualifiedShots &&
    qualifiedShotCount <= config.provisionalMaxQualifiedShots
      ? 'Provisional '
      : ''
  const fieldSummary = fieldScores.map((field) => field.label).join(', ')

  return {
    modelId: MODEL_ID,
    modelVersion: MODEL_VERSION,
    value: score,
    explanation: `${provisionalPrefix}${qualifiedShotCount} qualified shots across ${coreFieldsPresent} fields (${fieldSummary})`,
    evidence: { shotCount: qualifiedShotCount, sessionCount },
    trace: [
      {
        id: 'flight-evidence',
        label: 'Flight evidence',
        description: 'Count shots with at least one usable flight field and the number of fields that can be scored.',
        values: { qualifiedShots: qualifiedShotCount, coreFieldsPresent },
      },
      ...fieldScores.map((field) => ({
        id: `field-${field.key}`,
        label: `${field.label} repeatability`,
        description: 'Weighted mean absolute deviation is normalized by the legacy field denominator and converted to a 0-100 score.',
        values: {
          center: oneDecimal(field.center),
          meanAbsoluteDeviation: oneDecimal(field.deviation),
          denominator: oneDecimal(field.denominator),
          relativeDeviation: Number(field.relativeDeviation.toFixed(3)),
          score: oneDecimal(field.score),
          baseWeight: field.baseWeight,
        },
      })),
      {
        id: 'flight-blend',
        label: 'Flight Quality score',
        description: 'Available field scores are weight-renormalized, then adjusted for missing field coverage.',
        values: { baseScore: oneDecimal(flightQualityBase), availabilityAdjustment, finalScore: score },
      },
    ],
  }
}
