import type { BrowserGsproCourseArchiveShot } from '../adapters/browserGsproCourseArchive'
import type { SavedSession, Shot } from '../types'
import {
  activeBagClubIds,
  loadBagConfig,
  type Club,
} from './bagConfig'
import { isShotIncludedInAnalysis } from './historicalModel'
import {
  LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY,
  persistWorkingCacheValueForActiveUser,
} from './localUserScope'
import { buildShotProfilesForIdentity } from './shotProfiles'
import { parseDecisionOptions, type DecisionOption } from '../liveCaddie/decisionOptions'

export const LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT = 'looper-live-caddie-armed-club-updated'
export const CLUB_INFERENCE_MODEL_VERSION = 'player-gaussian-v1'

export type ArmedLiveShotIntent = {
  /** Exact shot identity shown by Live Caddie when the club was armed. */
  variant: string | null
  /** Player baseline frozen at arm time, before wind/elevation/lie transforms. */
  stockCarryYds: number | null
  /** Swing/variant carry Looper asked the player to produce before environment transforms. */
  plannedCarryYds: number | null
  /** Condition-adjusted carry Looper modeled for the armed shot. */
  modeledCarryYds: number | null
  /** Player-facing aim instruction frozen at arm time. Negative = left, positive = right. */
  aimOffsetYds: number | null
  source: 'live-caddie-recommendation' | 'manual-club-selection'
  /** The engine's numbers for its pick and the alternatives at arm time (caddie vs you). */
  options?: DecisionOption[] | null
}

export type ArmedLiveClub = {
  club: Club
  armedAt: string
  recommendedClub: Club | null
  intent: ArmedLiveShotIntent | null
}

export type ClubInferenceAlternative = {
  club: Club
  probability: number
  score: number
  supportShots: number
}

export type ClubInferenceResult = {
  predictedClub: Club | null
  confidence: number | null
  alternatives: ClubInferenceAlternative[]
  modelVersion: typeof CLUB_INFERENCE_MODEL_VERSION
  evaluatedAt: string
  metricsUsed: string[]
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const configuredClubs = (): Club[] =>
  loadBagConfig()?.selectedClubs ?? [...activeBagClubIds]

const isClub = (value: unknown): value is Club =>
  typeof value === 'string' && configuredClubs().includes(value as Club)

const nullableFiniteNumber = (value: unknown) => finite(value) ? value : null

const parseIntent = (value: unknown): ArmedLiveShotIntent | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<ArmedLiveShotIntent>
  const source = candidate.source === 'live-caddie-recommendation'
    || candidate.source === 'manual-club-selection'
    ? candidate.source
    : null
  if (!source) return null
  return {
    variant: typeof candidate.variant === 'string' ? candidate.variant : null,
    stockCarryYds: nullableFiniteNumber(candidate.stockCarryYds),
    plannedCarryYds: nullableFiniteNumber(candidate.plannedCarryYds),
    modeledCarryYds: nullableFiniteNumber(candidate.modeledCarryYds),
    aimOffsetYds: nullableFiniteNumber(candidate.aimOffsetYds),
    source,
    options: parseDecisionOptions(candidate.options),
  }
}

export const loadArmedLiveClub = (): ArmedLiveClub | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ArmedLiveClub>
    if (!isClub(parsed.club) || typeof parsed.armedAt !== 'string') return null
    return {
      club: parsed.club,
      armedAt: parsed.armedAt,
      recommendedClub: isClub(parsed.recommendedClub) ? parsed.recommendedClub : null,
      intent: parseIntent(parsed.intent),
    }
  } catch {
    return null
  }
}

export const armLiveClub = (
  club: Club,
  recommendedClub: Club | null = null,
  intent: ArmedLiveShotIntent | null = null,
): ArmedLiveClub => {
  const armed: ArmedLiveClub = {
    club,
    armedAt: new Date().toISOString(),
    recommendedClub,
    intent,
  }
  const serialized = JSON.stringify(armed)
  window.localStorage.setItem(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY, serialized)
  persistWorkingCacheValueForActiveUser(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY, serialized)
  window.dispatchEvent(new Event(LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT))
  return armed
}

export const clearArmedLiveClub = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY)
  persistWorkingCacheValueForActiveUser(LIVE_CADDIE_ARMED_CLUB_STORAGE_KEY, null)
  window.dispatchEvent(new Event(LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT))
}

type MetricDefinition = {
  name: string
  observed: number | null
  mean: number | undefined
  sigma: number | undefined
  floorSigma: number
  weight: number
}

const inferenceScore = (metrics: readonly MetricDefinition[]) => {
  const usable = metrics.filter(
    (metric) => finite(metric.observed) && finite(metric.mean),
  )
  if (usable.length === 0) return null

  let weightedSquaredZ = 0
  let totalWeight = 0
  for (const metric of usable) {
    const sigma = Math.max(
      metric.floorSigma,
      finite(metric.sigma) ? Math.abs(metric.sigma) : 0,
    )
    const z = ((metric.observed as number) - (metric.mean as number)) / sigma
    weightedSquaredZ += metric.weight * z * z
    totalWeight += metric.weight
  }

  return {
    score: totalWeight > 0 ? weightedSquaredZ / totalWeight : Number.POSITIVE_INFINITY,
    metricsUsed: usable.map((metric) => metric.name),
  }
}

const sessionShotsForClub = (sessions: readonly SavedSession[], club: Club): Shot[] =>
  sessions
    .filter((session) => session.metadata?.includeInAnalysis !== false)
    .flatMap((session) => session.shots)
    .filter((shot) => shot.club === club && isShotIncludedInAnalysis(shot))

/**
 * Shadow-only club classifier. Manual attribution remains authoritative.
 *
 * This intentionally starts simple and player-specific: compare the observed
 * GSPro shot with each club's historical Stock profile using robust per-metric
 * spreads (plus conservative floors), then normalize the relative likelihoods.
 * The stored predictions give us labeled validation data before inference is
 * ever allowed to assign a club operationally.
 */
export const inferClubForGsproShot = (
  sessions: readonly SavedSession[],
  shot: BrowserGsproCourseArchiveShot,
  evaluatedAt = new Date().toISOString(),
): ClubInferenceResult => {
  const candidates = configuredClubs().flatMap((club) => {
    const historicalShots = sessionShotsForClub(sessions, club)
    if (historicalShots.length < 3) return []

    const profile = buildShotProfilesForIdentity({
      shots: historicalShots,
      club,
    }).mostLikely
    if (!profile) return []

    const result = inferenceScore([
      {
        name: 'carry',
        observed: shot.carryYards,
        mean: profile.carry,
        sigma: profile.carryVariability,
        floorSigma: 7,
        weight: 1.5,
      },
      {
        name: 'total',
        observed: shot.totalYards,
        mean: profile.total,
        sigma: profile.totalVariability,
        floorSigma: 9,
        weight: 0.8,
      },
      {
        name: 'ball_speed',
        observed: shot.ballSpeedMph,
        mean: profile.ballSpeed,
        sigma: undefined,
        floorSigma: 5,
        weight: 1.25,
      },
      {
        name: 'launch',
        observed: shot.verticalLaunchAngleDegrees,
        mean: profile.launch,
        sigma: profile.launchVariability,
        floorSigma: 3.5,
        weight: 0.55,
      },
      {
        name: 'spin',
        observed: shot.totalSpinRpm,
        mean: profile.spin,
        sigma: profile.spinVariability,
        floorSigma: 800,
        weight: 0.45,
      },
    ])
    if (!result || result.metricsUsed.length < 2) return []

    // Slightly temper tiny historical samples without allowing support volume
    // to overwhelm the actual launch/distance similarity.
    const supportPrior = Math.min(1, Math.sqrt(historicalShots.length / 10))
    const likelihood = Math.exp(-0.5 * result.score) * supportPrior
    return [{
      club,
      score: result.score,
      likelihood,
      supportShots: historicalShots.length,
      metricsUsed: result.metricsUsed,
    }]
  })

  if (candidates.length === 0) {
    return {
      predictedClub: null,
      confidence: null,
      alternatives: [],
      modelVersion: CLUB_INFERENCE_MODEL_VERSION,
      evaluatedAt,
      metricsUsed: [],
    }
  }

  const denominator = candidates.reduce((sum, candidate) => sum + candidate.likelihood, 0)
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      probability: denominator > 0 ? candidate.likelihood / denominator : 0,
    }))
    .sort((left, right) => right.probability - left.probability)

  const top = ranked[0]
  return {
    predictedClub: top?.club ?? null,
    confidence: top?.probability ?? null,
    alternatives: ranked.slice(0, 3).map((candidate) => ({
      club: candidate.club,
      probability: candidate.probability,
      score: candidate.score,
      supportShots: candidate.supportShots,
    })),
    modelVersion: CLUB_INFERENCE_MODEL_VERSION,
    evaluatedAt,
    metricsUsed: top?.metricsUsed ?? [],
  }
}

const syncVisibleArmedClubState = () => {
  if (typeof document === 'undefined') return
  const armed = loadArmedLiveClub()

  document.querySelectorAll<HTMLButtonElement>('.live-club-strip button').forEach((button) => {
    const clubText = button.querySelector('strong')?.textContent?.trim()
    const isArmed = Boolean(armed && clubText === armed.club)
    button.classList.toggle('armed', isArmed)
    button.setAttribute('aria-pressed', isArmed ? 'true' : 'false')
  })

  const heading = document.querySelector<HTMLElement>('.live-club-strip-heading strong')
  if (heading) {
    heading.textContent = armed
      ? `${armed.club} armed for the next physical shot`
      : 'Tap the club you are actually hitting'
  }
}

const scheduleVisibleArmedClubSync = () => {
  if (typeof window === 'undefined') return
  window.setTimeout(syncVisibleArmedClubState, 0)
}

const recommendedClubFromUi = (): Club | null => {
  const recommendationText = document
    .querySelector('.live-club-strip button.recommended strong')
    ?.textContent
    ?.trim()
  if (isClub(recommendationText)) return recommendationText

  // Fallback for older Live Caddie markup where the club strip did not expose
  // a dedicated recommendation marker.
  const heroText = document.querySelector('.live-club-hero')?.textContent?.trim()
  return isClub(heroText) ? heroText : null
}

const datasetNumber = (element: HTMLElement | null, key: string) => {
  const raw = element?.dataset[key]
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

const aimOffsetFromUi = () => {
  const text = document.querySelector('.live-aim-hero')?.textContent?.trim().toLowerCase() ?? ''
  if (!text || text.includes('center')) return 0
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*yd\s*(left|right)/)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  return match[2] === 'left' ? -amount : amount
}

const shotIntentFromUi = (
  source: ArmedLiveShotIntent['source'],
): ArmedLiveShotIntent | null => {
  const block = document.querySelector<HTMLElement>('.live-expected-shot-block')
  if (!block) return null
  const variant = block.dataset.shotVariant?.trim() || null
  const stockCarryYds = datasetNumber(block, 'stockCarryYds')
  const plannedCarryYds = datasetNumber(block, 'plannedCarryYds')
  const modeledCarryYds = datasetNumber(block, 'modeledCarryYds')
  const aimOffsetYds = aimOffsetFromUi()
  const options = parseDecisionOptions(block.dataset.decisionOptions)
  if (
    !variant
    && stockCarryYds == null
    && plannedCarryYds == null
    && modeledCarryYds == null
    && aimOffsetYds == null
    && !options
  ) return null
  return {
    variant,
    stockCarryYds,
    plannedCarryYds,
    modeledCarryYds,
    aimOffsetYds,
    source,
    options,
  }
}

const armFromCurrentUi = (
  club: Club,
  recommendedClub: Club | null,
  source: ArmedLiveShotIntent['source'],
) => {
  // React updates the viewed alternate club before this task runs. Deferring the
  // capture prevents an alternate-club click from freezing the prior club's intent.
  window.setTimeout(() => {
    armLiveClub(club, recommendedClub, shotIntentFromUi(source))
    scheduleVisibleArmedClubSync()
  }, 0)
}

/**
 * Transitional UI bridge: Live Caddie already owns the visible armed state.
 * Capture those existing clicks into the durable attribution state while also
 * keeping the strip visibly synchronized with the persisted armed selection.
 */
const installLiveCaddieClubClickBridge = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const bridgedWindow = window as Window & { __looperLiveClubClickBridge?: boolean }
  if (bridgedWindow.__looperLiveClubClickBridge) return
  bridgedWindow.__looperLiveClubClickBridge = true

  window.addEventListener(LIVE_CADDIE_ARMED_CLUB_UPDATED_EVENT, scheduleVisibleArmedClubSync)

  document.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('button')
    if (!(button instanceof HTMLButtonElement)) return

    if (button.closest('.live-club-strip-heading') && button.textContent?.trim() === 'Clear') {
      clearArmedLiveClub()
      scheduleVisibleArmedClubSync()
      return
    }

    const recommendedClub = recommendedClubFromUi()

    if (button.closest('.live-club-strip')) {
      const clubText = button.querySelector('strong')?.textContent?.trim()
      if (isClub(clubText)) {
        armFromCurrentUi(clubText, recommendedClub, 'manual-club-selection')
      }
      return
    }

    if (button.classList.contains('live-arm-recommendation')) {
      const displayedClubText = document.querySelector('.live-club-hero')?.textContent?.trim()
      const displayedClub = isClub(displayedClubText) ? displayedClubText : recommendedClub
      if (displayedClub) {
        armFromCurrentUi(displayedClub, recommendedClub, 'live-caddie-recommendation')
      }
    }
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleVisibleArmedClubSync, { once: true })
  } else {
    scheduleVisibleArmedClubSync()
  }
}

installLiveCaddieClubClickBridge()
