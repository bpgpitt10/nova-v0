import type { Club } from './bagConfig'
import { getClubLabel } from './bagConfig'
import { confidenceConfig } from './confidenceConfig'
import {
  isShotIncludedInAnalysis,
  isShotSourceIncluded,
  sessionHistoricalWeightForClub,
} from './historicalModel'
import { getInstalledMishitClassification } from './mishitPlanningPopulation'
import { summarizeReviewClub } from './scoring'
import { buildShotProfilesForIdentity, carryValue, type ShotProfiles } from './shotProfiles'
import {
  getShotVariantsForClub,
  resolveShotVariantId,
  shotsForClubVariant,
  STOCK_SHOT_VARIANT_ID,
} from './shotVariants'
import type { ReviewClubSummary, SavedSession, Shot } from '../types'

/**
 * The bag "yardage book": one row per club (its default variant) plus one row
 * per custom variant that has shots. Every number is built from the same
 * helpers Club Detail uses, so a row always matches the club page it opens.
 */

export type YardageBookCarryTotal = {
  carry: number
  total: number | null
}

export type YardageBookMishits = {
  /** Share of classified shots the classifier called mishit or severe_mishit. */
  rate: number
  severeRate: number
  classifiedShots: number
}

export type YardageBookRow = {
  club: Club
  variantId: string
  variantName: string
  isDefaultVariant: boolean
  /** Planning shots (source-included, not mishits) behind the numbers. */
  swings: number
  needsData: boolean
  stock: YardageBookCarryTotal | null
  pure: YardageBookCarryTotal | null
  /** Weighted 25th–75th percentile of planning carries. */
  middleHalf: { low: number; high: number } | null
  /** Stock profile mean offline in yards; positive is right. */
  missOffline: number | null
  /** Stock profile spread (the ± on the Club Ladder PDF, same as The Read). */
  spread: { carry: number | null; total: number | null; offline: number | null }
  mishits: YardageBookMishits | null
  trust: { score: number; call: ReviewClubSummary['caddieCall'] } | null
}

export type YardageBookClub = {
  club: Club
  label: string
  row: YardageBookRow
  variants: YardageBookRow[]
}

export type YardageBook = {
  clubs: YardageBookClub[]
  totalSwings: number
  lastSessionEndedAt: string | null
}

type IdentityInputs = {
  sessions: SavedSession[]
  shots: Shot[]
  shotWeightsById: Map<string, number>
}

/**
 * Same session/shot selection and per-shot weighting Club Detail uses
 * (App.tsx selectedDetailVariantSessions + selectedClubHistoricalShotWeights).
 */
export const buildIdentityInputs = (
  analysisSessions: SavedSession[],
  club: Club,
  variantId: string,
  nowMs: number,
): IdentityInputs => {
  const sessions = analysisSessions.map((session) => ({
    ...session,
    shots: shotsForClubVariant(session.shots, club, variantId).filter(isShotIncludedInAnalysis),
  }))
  const shotWeightsById = new Map<string, number>()
  analysisSessions.forEach((session, index) => {
    const identityShots = sessions[index].shots
    const sessionWeight = sessionHistoricalWeightForClub(session, club, nowMs)
    const shotWeight = identityShots.length > 0 ? sessionWeight / identityShots.length : 0
    identityShots.forEach((shot) => {
      if (!shotWeightsById.has(shot.id)) {
        shotWeightsById.set(shot.id, shotWeight)
      }
    })
  })
  return {
    sessions,
    shots: sessions.flatMap((session) => session.shots),
    shotWeightsById,
  }
}

export const buildIdentityProfiles = (
  analysisSessions: SavedSession[],
  club: Club,
  variantId: string,
  nowMs: number,
): ShotProfiles => {
  const { shots, shotWeightsById } = buildIdentityInputs(analysisSessions, club, variantId, nowMs)
  return buildShotProfilesForIdentity({ shots, club, shotWeightsById })
}

const weightedQuantile = (
  rows: Array<{ value: number; weight: number }>,
  quantile: number,
) => {
  if (rows.length === 0) {
    return null
  }
  const sorted = [...rows].sort((left, right) => left.value - right.value)
  const totalWeight = sorted.reduce((sum, row) => sum + row.weight, 0)
  // Sessions past the decay window can weigh ~0; fall back to equal weights.
  const useEqual = !(totalWeight > 0)
  const total = useEqual ? sorted.length : totalWeight
  const target = quantile * total
  let cumulative = 0
  for (const row of sorted) {
    cumulative += useEqual ? 1 : row.weight
    if (cumulative >= target) {
      return row.value
    }
  }
  return sorted[sorted.length - 1].value
}

const buildMiddleHalf = (shots: Shot[], shotWeightsById: Map<string, number>) => {
  const rows = shots
    .map((shot) => ({ value: carryValue(shot), weight: shotWeightsById.get(shot.id) ?? 0 }))
    .filter((row): row is { value: number; weight: number } => typeof row.value === 'number')
  const low = weightedQuantile(rows, 0.25)
  const high = weightedQuantile(rows, 0.75)
  return low === null || high === null ? null : { low, high }
}

const buildMishits = (
  analysisSessions: SavedSession[],
  club: Club,
  variantId: string,
): YardageBookMishits | null => {
  let classified = 0
  let mishit = 0
  let severe = 0
  analysisSessions.forEach((session) => {
    shotsForClubVariant(session.shots, club, variantId)
      .filter(isShotSourceIncluded)
      .forEach((shot) => {
        const classification = getInstalledMishitClassification(shot.id)?.classification
        if (!classification || classification === 'unclassified') {
          return
        }
        classified += 1
        if (classification === 'mishit') mishit += 1
        if (classification === 'severe_mishit') severe += 1
      })
  })
  if (classified === 0) {
    return null
  }
  return {
    rate: (mishit + severe) / classified,
    severeRate: severe / classified,
    classifiedShots: classified,
  }
}

const finiteOrNull = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const carryTotal = (profile: ShotProfiles['mostLikely']): YardageBookCarryTotal | null =>
  profile && typeof profile.carry === 'number'
    ? { carry: profile.carry, total: typeof profile.total === 'number' ? profile.total : null }
    : null

export const buildYardageBookRow = (
  analysisSessions: SavedSession[],
  club: Club,
  variantId: string,
  variantName: string,
  nowMs: number,
): YardageBookRow => {
  const resolvedVariantId = resolveShotVariantId(variantId)
  const { sessions, shots, shotWeightsById } = buildIdentityInputs(
    analysisSessions,
    club,
    resolvedVariantId,
    nowMs,
  )
  const needsData = shots.length < confidenceConfig.insufficientData.minIncludedShots
  const profiles = buildShotProfilesForIdentity({ shots, club, shotWeightsById })
  const summary = shots.length > 0 ? summarizeReviewClub(club, shots, sessions, null) : null

  return {
    club,
    variantId: resolvedVariantId,
    variantName,
    isDefaultVariant: resolvedVariantId === STOCK_SHOT_VARIANT_ID,
    swings: shots.length,
    needsData,
    stock: carryTotal(profiles.mostLikely),
    pure: carryTotal(profiles.bestAvailable),
    middleHalf: buildMiddleHalf(shots, shotWeightsById),
    missOffline:
      typeof profiles.mostLikely?.offlineMean === 'number' ? profiles.mostLikely.offlineMean : null,
    spread: {
      carry: finiteOrNull(profiles.mostLikely?.carryVariability),
      total: finiteOrNull(profiles.mostLikely?.totalVariability),
      offline: finiteOrNull(profiles.mostLikely?.dispersionVariability),
    },
    mishits: buildMishits(analysisSessions, club, resolvedVariantId),
    trust: summary ? { score: summary.caddieScore, call: summary.caddieCall } : null,
  }
}

const hasAnyShots = (analysisSessions: SavedSession[], club: Club, variantId: string) =>
  analysisSessions.some((session) =>
    shotsForClubVariant(session.shots, club, variantId).some(isShotSourceIncluded),
  )

export const buildYardageBook = (
  analysisSessions: SavedSession[],
  bagClubs: Club[],
  nowMs = Date.now(),
): YardageBook => {
  const clubs = bagClubs.map((club) => {
    const [defaultVariant, ...customVariants] = getShotVariantsForClub(club)
    const row = buildYardageBookRow(
      analysisSessions,
      club,
      defaultVariant.id,
      defaultVariant.name,
      nowMs,
    )
    const variants = customVariants
      .filter((variant) => hasAnyShots(analysisSessions, club, variant.id))
      .map((variant) =>
        buildYardageBookRow(analysisSessions, club, variant.id, variant.name, nowMs),
      )
    return { club, label: getClubLabel(club), row, variants }
  })

  const lastSessionEndedAt =
    analysisSessions
      .map((session) => session.endedAt)
      .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null

  return {
    clubs,
    totalSwings: clubs.reduce(
      (sum, entry) =>
        sum + entry.row.swings + entry.variants.reduce((inner, row) => inner + row.swings, 0),
      0,
    ),
    lastSessionEndedAt,
  }
}

/** "4 R", "3 L", "Straight" — positive offline is right. */
export const formatMiss = (offline: number | null) => {
  if (offline === null) return '–'
  const rounded = Math.round(offline)
  if (rounded === 0) return 'Straight'
  return `${Math.abs(rounded)} ${rounded > 0 ? 'R' : 'L'}`
}

/**
 * The club whose default-variant mishit rate stands out most against the bag,
 * or null when nothing does. Needs a real sample before it will call one out.
 */
export const findMishitPressurePoint = (book: YardageBook) => {
  const candidates = book.clubs
    .map((entry) => ({ entry, mishits: entry.row.mishits }))
    .filter(
      (candidate): candidate is { entry: YardageBookClub; mishits: YardageBookMishits } =>
        candidate.mishits !== null && candidate.mishits.classifiedShots >= 20,
    )
  if (candidates.length < 3) {
    return null
  }
  const classified = candidates.reduce((sum, c) => sum + c.mishits.classifiedShots, 0)
  const average =
    candidates.reduce((sum, c) => sum + c.mishits.rate * c.mishits.classifiedShots, 0) / classified
  const worst = [...candidates].sort((left, right) => right.mishits.rate - left.mishits.rate)[0]
  if (worst.mishits.rate < 0.1 || worst.mishits.rate < average * 1.5) {
    return null
  }
  return { club: worst.entry.club, label: worst.entry.label, rate: worst.mishits.rate, average }
}
