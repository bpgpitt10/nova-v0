import {
  DEFAULT_MISHIT_CONFIG,
  analyzeShotPopulation,
  type MishitAnalysis,
  type MishitClassification,
  type MishitShot,
} from '../mishit-classifier'
import type { OpenGolfCoachPayload, SavedSession, Shot } from '../types'
import { resolveShotVariantId } from './shotVariants'

/**
 * Looper-side bridge between immutable shot history and planning truth.
 *
 * Raw shots are never mutated. Human validation labels are deliberately not
 * inputs here. The standalone classifier groups each player's shots by club +
 * variant and derives planning eligibility from the golf data only.
 */
export type MishitPlanningPopulation = {
  populationKey: string
  analysis: MishitAnalysis
}

export type MishitPlanningState = {
  classificationByShotId: Map<string, MishitClassification>
  populations: Map<string, MishitPlanningPopulation>
  planningEligibleShotIds: Set<string>
  excludedMishitShotIds: Set<string>
}

let installedPlanningState: MishitPlanningState = {
  classificationByShotId: new Map(),
  populations: new Map(),
  planningEligibleShotIds: new Set(),
  excludedMishitShotIds: new Set(),
}

const finiteNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const payloadNumber = (payload: OpenGolfCoachPayload | undefined, keys: string[]) => {
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

export const toMishitPlanningShot = (shot: Shot): MishitShot => {
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

export const mishitPlanningPopulationKey = (
  shot: Pick<Shot, 'club' | 'shotVariantId'>,
) => `${shot.club}::${resolveShotVariantId(shot.shotVariantId)}`

export const buildMishitPlanningState = (
  sessions: SavedSession[],
): MishitPlanningState => {
  const groupedShots = new Map<string, Shot[]>()

  sessions.forEach((session) => {
    session.shots.forEach((shot) => {
      // Source/manual exclusion remains separate and stronger than derived
      // mishit interpretation. Excluded shots do not teach the classifier.
      if (shot.included === false) {
        return
      }
      const populationKey = mishitPlanningPopulationKey(shot)
      const group = groupedShots.get(populationKey) ?? []
      group.push(shot)
      groupedShots.set(populationKey, group)
    })
  })

  const classificationByShotId = new Map<string, MishitClassification>()
  const populations = new Map<string, MishitPlanningPopulation>()
  const planningEligibleShotIds = new Set<string>()
  const excludedMishitShotIds = new Set<string>()

  groupedShots.forEach((shots, populationKey) => {
    // No human labels or manual per-player overrides are passed to the
    // classifier. Personalization comes from the player's own robust sample.
    const analysis = analyzeShotPopulation(
      shots.map(toMishitPlanningShot),
      DEFAULT_MISHIT_CONFIG,
    )
    populations.set(populationKey, { populationKey, analysis })

    analysis.classifications.forEach((classification) => {
      classificationByShotId.set(classification.shotId, classification)
      if (classification.planningEligible) {
        planningEligibleShotIds.add(classification.shotId)
      } else {
        excludedMishitShotIds.add(classification.shotId)
      }
    })
  })

  return {
    classificationByShotId,
    populations,
    planningEligibleShotIds,
    excludedMishitShotIds,
  }
}

export const installMishitPlanningState = (sessions: SavedSession[]) => {
  installedPlanningState = buildMishitPlanningState(sessions)
  return installedPlanningState
}

/**
 * Unknown / unclassified shots remain planning eligible by default. This keeps
 * cold-start behavior conservative and prevents missing derived state from
 * silently deleting real golf from planning calculations.
 */
export const isShotMishitPlanningEligible = (shotId: string) =>
  installedPlanningState.classificationByShotId.get(shotId)?.planningEligible !== false

export const getInstalledMishitClassification = (shotId: string) =>
  installedPlanningState.classificationByShotId.get(shotId)

export const getInstalledMishitPlanningState = () => installedPlanningState

export const filterPlanningShots = (shots: Shot[]) =>
  shots.filter(
    (shot) =>
      shot.included !== false && isShotMishitPlanningEligible(shot.id),
  )

export const filterPlanningSessions = (sessions: SavedSession[]) =>
  sessions.map((session) => ({
    ...session,
    shots: filterPlanningShots(session.shots),
  }))
