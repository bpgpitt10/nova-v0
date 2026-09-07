import {
  DEFAULT_MISHIT_CONFIG,
  analyzeShotPopulation,
  type MishitBaseline,
  type MishitClass,
  type MishitClassification,
  type MishitEffectiveThresholds,
  type MishitPlayerCalibration,
  type MishitReason,
  type MishitShot,
} from '../mishit-classifier'
import type { Shot } from '../types'
import { loadMishitPlayerCalibrations } from './mishitPlayerCalibration'
import {
  loadHumanShotReviews,
  type HumanShotJudgment,
  type HumanShotReview,
} from './shotReview'
import { loadActiveSessionDraft, loadSavedSessions } from './sessions'
import { resolveShotVariantId } from './shotVariants'

export const MISHIT_VALIDATION_SNAPSHOT_VERSION = 2

export type MishitValidationAgreement =
  | 'exact'
  | 'planning_match'
  | 'false_positive'
  | 'false_negative'
  | 'not_comparable'
  | 'unreviewed'
  | 'excluded'

export type MishitValidationShot = {
  shotId: string
  sessionId: string
  sessionStartedAt: string
  sessionEndedAt?: string
  activeSession: boolean
  club: string
  shotVariantId: string
  populationKey: string
  capturedAt: string
  source: Shot['source']
  sourceIncluded: boolean
  classifierPopulationEligible: boolean
  shotName?: string
  shotRanking?: number | string
  feltPerfect?: boolean
  metrics: MishitShot
  humanReview?: HumanShotReview
  automatic?: {
    classification: MishitClass
    planningEligible: boolean
    confidence: number
    baselineVersion: number
    baselineStatus: MishitClassification['baselineStatus']
    reasons: MishitReason[]
  }
  agreement: MishitValidationAgreement
}

export type MishitValidationPopulation = {
  populationKey: string
  club: string
  shotVariantId: string
  allShotCount: number
  classifierShotCount: number
  humanReviewedCount: number
  comparableHumanCount: number
  baseline: MishitBaseline
  inputVersion: number
  calibrationVersion?: number
  playerCalibration?: MishitPlayerCalibration
  effectiveThresholds: MishitEffectiveThresholds
  classifierCounts: Record<MishitClass, number>
  comparison: {
    exactMatches: number
    planningMatches: number
    falsePositives: number
    falseNegatives: number
    planningAgreementRate: number | null
  }
}

export type MishitValidationSnapshot = {
  schemaVersion: number
  generatedAt: string
  classifierConfig: typeof DEFAULT_MISHIT_CONFIG
  playerCalibrations: Record<string, MishitPlayerCalibration>
  notes: string[]
  summary: {
    shotRecords: number
    reviewedJudgments: number
    comparableJudgments: number
    exactMatches: number
    planningMatches: number
    falsePositives: number
    falseNegatives: number
    intentional: number
    unsure: number
    unreviewed: number
    planningAgreementRate: number | null
  }
  populations: MishitValidationPopulation[]
  shots: MishitValidationShot[]
  orphanReviews: HumanShotReview[]
}

type StoredShotRecord = {
  shot: Shot
  sessionId: string
  sessionStartedAt: string
  sessionEndedAt?: string
  activeSession: boolean
}

const finiteNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const payloadNumber = (payload: Shot['openGolfCoach'], keys: string[]) => {
  if (!payload) {
    return undefined
  }

  const stack: unknown[] = [payload]
  const visited = new Set<object>()

  while (stack.length > 0) {
    const value = stack.pop()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }
    if (visited.has(value)) {
      continue
    }
    visited.add(value)

    const record = value as Record<string, unknown>
    for (const key of keys) {
      const candidate = finiteNumber(record[key])
      if (typeof candidate === 'number') {
        return candidate
      }
      if (typeof record[key] === 'string') {
        const parsed = Number(record[key])
        if (Number.isFinite(parsed)) {
          return parsed
        }
      }
    }

    Object.values(record).forEach((nested) => stack.push(nested))
  }

  return undefined
}

const toMishitShot = (shot: Shot): MishitShot => {
  const ballSpeed =
    finiteNumber(shot.ballSpeedMph) ??
    (typeof shot.ballSpeedMetersPerSecond === 'number'
      ? shot.ballSpeedMetersPerSecond * 2.23694
      : payloadNumber(shot.openGolfCoach, ['ball_speed_mph', 'ballSpeedMph']))

  return {
    id: shot.id,
    capturedAt: shot.capturedAt,
    carry:
      finiteNumber(shot.carryYards) ??
      payloadNumber(shot.openGolfCoach, [
        'carry_distance_yards',
        'carryDistanceYards',
        'carry',
      ]),
    total:
      finiteNumber(shot.totalYards) ??
      payloadNumber(shot.openGolfCoach, [
        'total_distance_yards',
        'totalDistanceYards',
        'total',
      ]),
    offline:
      finiteNumber(shot.offlineYards) ??
      payloadNumber(shot.openGolfCoach, [
        'offline_distance_yards',
        'offlineDistanceYards',
        'offline',
      ]),
    ballSpeed,
    clubSpeed:
      finiteNumber(shot.clubSpeed) ??
      payloadNumber(shot.openGolfCoach, ['club_speed_mph', 'clubSpeedMph']),
    smashFactor:
      finiteNumber(shot.smashFactor) ??
      payloadNumber(shot.openGolfCoach, ['smash_factor', 'smashFactor', 'smash']),
    launch:
      finiteNumber(shot.verticalLaunchAngleDegrees) ??
      finiteNumber(shot.launchAngleDeg) ??
      payloadNumber(shot.openGolfCoach, [
        'vertical_launch_angle_degrees',
        'verticalLaunchAngleDegrees',
        'launch_angle_degrees',
        'launchAngleDeg',
      ]),
    spin:
      finiteNumber(shot.totalSpinRpm) ??
      finiteNumber(shot.spinRpm) ??
      payloadNumber(shot.openGolfCoach, [
        'total_spin_rpm',
        'totalSpinRpm',
        'spin_rpm',
      ]),
  }
}

const isComparableJudgment = (
  judgment: HumanShotJudgment | undefined,
): judgment is 'normal' | 'mishit' | 'severe_mishit' =>
  judgment === 'normal' || judgment === 'mishit' || judgment === 'severe_mishit'

const agreementFor = (
  review: HumanShotReview | undefined,
  automatic: MishitClassification | undefined,
  classifierPopulationEligible: boolean,
): MishitValidationAgreement => {
  if (!review?.judgment) {
    return 'unreviewed'
  }
  if (review.judgment === 'intentional' || review.judgment === 'unsure') {
    return 'not_comparable'
  }
  if (!classifierPopulationEligible || !automatic) {
    return 'excluded'
  }
  if (automatic.classification === review.judgment) {
    return 'exact'
  }

  const humanPlanningEligible = review.judgment === 'normal'
  if (humanPlanningEligible && !automatic.planningEligible) {
    return 'false_positive'
  }
  if (!humanPlanningEligible && automatic.planningEligible) {
    return 'false_negative'
  }
  return 'planning_match'
}

const collectShotRecords = (): StoredShotRecord[] => {
  const byShotId = new Map<string, StoredShotRecord>()

  loadSavedSessions().forEach((session) => {
    session.shots.forEach((shot) => {
      byShotId.set(shot.id, {
        shot,
        sessionId: session.id,
        sessionStartedAt: session.startedAt,
        sessionEndedAt: session.endedAt,
        activeSession: false,
      })
    })
  })

  const active = loadActiveSessionDraft()
  active?.shots.forEach((shot) => {
    byShotId.set(shot.id, {
      shot,
      sessionId: active.id,
      sessionStartedAt: active.startedAt,
      activeSession: true,
    })
  })

  return [...byShotId.values()].sort((a, b) =>
    a.shot.capturedAt.localeCompare(b.shot.capturedAt),
  )
}

const countClassifications = (classifications: MishitClassification[]) => {
  const counts: Record<MishitClass, number> = {
    unclassified: 0,
    normal: 0,
    mishit: 0,
    severe_mishit: 0,
  }
  classifications.forEach((classification) => {
    counts[classification.classification] += 1
  })
  return counts
}

const comparisonSummary = (rows: MishitValidationShot[]) => {
  const comparable = rows.filter((row) =>
    isComparableJudgment(row.humanReview?.judgment),
  )
  const exactMatches = comparable.filter((row) => row.agreement === 'exact').length
  const planningMatches = comparable.filter(
    (row) => row.agreement === 'exact' || row.agreement === 'planning_match',
  ).length
  const falsePositives = comparable.filter(
    (row) => row.agreement === 'false_positive',
  ).length
  const falseNegatives = comparable.filter(
    (row) => row.agreement === 'false_negative',
  ).length

  return {
    comparableCount: comparable.length,
    exactMatches,
    planningMatches,
    falsePositives,
    falseNegatives,
    planningAgreementRate:
      comparable.length > 0 ? planningMatches / comparable.length : null,
  }
}

export const buildMishitValidationSnapshot = (): MishitValidationSnapshot => {
  const records = collectShotRecords()
  const reviews = loadHumanShotReviews()
  const playerCalibrations = loadMishitPlayerCalibrations()
  const groups = new Map<string, StoredShotRecord[]>()

  records.forEach((record) => {
    const review = reviews[record.shot.id]
    const classifierPopulationEligible =
      record.shot.included !== false && review?.judgment !== 'intentional'
    if (!classifierPopulationEligible) {
      return
    }

    const shotVariantId = resolveShotVariantId(record.shot.shotVariantId)
    const populationKey = `${record.shot.club}::${shotVariantId}`
    const group = groups.get(populationKey) ?? []
    group.push(record)
    groups.set(populationKey, group)
  })

  const analysisByPopulation = new Map<
    string,
    {
      baseline: MishitBaseline
      inputVersion: number
      calibrationVersion?: number
      playerCalibration?: MishitPlayerCalibration
      effectiveThresholds: MishitEffectiveThresholds
      classifications: MishitClassification[]
      byShotId: Map<string, MishitClassification>
    }
  >()

  groups.forEach((group, populationKey) => {
    const playerCalibration = playerCalibrations[populationKey]
    const analysis = analyzeShotPopulation(
      group.map((record) => toMishitShot(record.shot)),
      DEFAULT_MISHIT_CONFIG,
      playerCalibration,
    )
    analysisByPopulation.set(populationKey, {
      baseline: analysis.baseline,
      inputVersion: analysis.inputVersion,
      calibrationVersion: analysis.calibrationVersion,
      playerCalibration,
      effectiveThresholds: analysis.effectiveThresholds,
      classifications: analysis.classifications,
      byShotId: new Map(
        analysis.classifications.map((classification) => [
          classification.shotId,
          classification,
        ]),
      ),
    })
  })

  const rows: MishitValidationShot[] = records.map((record) => {
    const shotVariantId = resolveShotVariantId(record.shot.shotVariantId)
    const populationKey = `${record.shot.club}::${shotVariantId}`
    const humanReview = reviews[record.shot.id]
    const classifierPopulationEligible =
      record.shot.included !== false && humanReview?.judgment !== 'intentional'
    const automatic = analysisByPopulation
      .get(populationKey)
      ?.byShotId.get(record.shot.id)

    return {
      shotId: record.shot.id,
      sessionId: record.sessionId,
      sessionStartedAt: record.sessionStartedAt,
      sessionEndedAt: record.sessionEndedAt,
      activeSession: record.activeSession,
      club: record.shot.club,
      shotVariantId,
      populationKey,
      capturedAt: record.shot.capturedAt,
      source: record.shot.source,
      sourceIncluded: record.shot.included !== false,
      classifierPopulationEligible,
      shotName: record.shot.shotName,
      shotRanking: record.shot.shotRanking,
      feltPerfect: record.shot.feltPerfect,
      metrics: toMishitShot(record.shot),
      humanReview,
      automatic: automatic
        ? {
            classification: automatic.classification,
            planningEligible: automatic.planningEligible,
            confidence: automatic.confidence,
            baselineVersion: automatic.baselineVersion,
            baselineStatus: automatic.baselineStatus,
            reasons: automatic.reasons,
          }
        : undefined,
      agreement: agreementFor(
        humanReview,
        automatic,
        classifierPopulationEligible,
      ),
    }
  })

  const populations: MishitValidationPopulation[] = [...groups.entries()]
    .map(([populationKey, group]) => {
      const analysis = analysisByPopulation.get(populationKey)
      if (!analysis) {
        return null
      }
      const sample = group[0]?.shot
      if (!sample) {
        return null
      }
      const shotVariantId = resolveShotVariantId(sample.shotVariantId)
      const populationRows = rows.filter((row) => row.populationKey === populationKey)
      const comparison = comparisonSummary(populationRows)

      return {
        populationKey,
        club: sample.club,
        shotVariantId,
        allShotCount: populationRows.length,
        classifierShotCount: group.length,
        humanReviewedCount: populationRows.filter((row) => row.humanReview?.judgment)
          .length,
        comparableHumanCount: comparison.comparableCount,
        baseline: analysis.baseline,
        inputVersion: analysis.inputVersion,
        calibrationVersion: analysis.calibrationVersion,
        playerCalibration: analysis.playerCalibration,
        effectiveThresholds: analysis.effectiveThresholds,
        classifierCounts: countClassifications(analysis.classifications),
        comparison: {
          exactMatches: comparison.exactMatches,
          planningMatches: comparison.planningMatches,
          falsePositives: comparison.falsePositives,
          falseNegatives: comparison.falseNegatives,
          planningAgreementRate: comparison.planningAgreementRate,
        },
      }
    })
    .filter((population): population is MishitValidationPopulation => Boolean(population))
    .sort((a, b) => a.populationKey.localeCompare(b.populationKey))

  const overall = comparisonSummary(rows)
  const shotIds = new Set(records.map((record) => record.shot.id))
  const orphanReviews = Object.values(reviews).filter(
    (review) => !shotIds.has(review.shotId),
  )

  return {
    schemaVersion: MISHIT_VALIDATION_SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    classifierConfig: DEFAULT_MISHIT_CONFIG,
    playerCalibrations,
    notes: [
      'Human labels are stored independently from raw shots and automatic classifications.',
      'Shared classifier defaults are starter policy, not player-specific learned thresholds.',
      'Each club + variant population has its own robust center and MAD-based variability.',
      'Stable player variability can widen exclusion boundaries but cannot make them more aggressive than global starter floors.',
      'Optional human/manual player calibrations are stored separately by population and exported here.',
      'Intentional shots are exported but excluded from classifier population construction.',
      'Shots with included=false are exported but excluded from classifier population construction.',
      'Unsure shots remain in the automatic population but are excluded from human-vs-auto accuracy counts.',
      'Automatic classifier results are included in this export but are not shown before human labeling in Session Intelligence.',
    ],
    summary: {
      shotRecords: rows.length,
      reviewedJudgments: rows.filter((row) => row.humanReview?.judgment).length,
      comparableJudgments: overall.comparableCount,
      exactMatches: overall.exactMatches,
      planningMatches: overall.planningMatches,
      falsePositives: overall.falsePositives,
      falseNegatives: overall.falseNegatives,
      intentional: rows.filter((row) => row.humanReview?.judgment === 'intentional').length,
      unsure: rows.filter((row) => row.humanReview?.judgment === 'unsure').length,
      unreviewed: rows.filter((row) => !row.humanReview?.judgment).length,
      planningAgreementRate: overall.planningAgreementRate,
    },
    populations,
    shots: rows,
    orphanReviews,
  }
}

export const downloadMishitValidationSnapshot = () => {
  const snapshot = buildMishitValidationSnapshot()
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `looper-mishit-validation-${snapshot.generatedAt.slice(0, 10)}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return snapshot
}
