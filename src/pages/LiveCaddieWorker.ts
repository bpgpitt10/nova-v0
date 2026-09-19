import { estimateGreywolfTerrain as estimateCourseTerrain } from '../courseGeometry/lidar'
import type {
  CourseHoleGeometry,
  CoursePointYds,
  CourseSurfaceClassification,
} from '../courseGeometry/types'
import {
  nextStateValueForAimCandidate,
  rankRiskAwareClubChoices,
} from '../liveCaddie/aimDecisionRanking'
import {
  evaluateAimLab,
  type AimCandidateEvaluation,
  type AimLabEnvironment,
  type ClubAimEvaluation,
} from '../liveCaddie/aimOptimization'
import type { DecisionRiskTailLanding } from '../liveCaddie/decisionRiskProfile'
import type { SavedSession } from '../types'

type LiveCaddieWorkerRequest = {
  sessions: SavedSession[]
  hole: CourseHoleGeometry
  ball: CoursePointYds
  target: CoursePointYds
  environment: AimLabEnvironment
  nowMs: number
}

type LandingElevationAwareEvaluation = ClubAimEvaluation & {
  landingElevationDeltaFt?: number | null
  landingElevationSource?: string | null
}

type LiveCaddieWorkerResponse =
  | { type: 'success'; evaluations: ClubAimEvaluation[] }
  | { type: 'error'; error: string }

type CachedEvaluationPayload = {
  cachedAt: number
  evaluations: ClubAimEvaluation[]
}

type LandingElevationResolution = {
  deltaFt: number | null
  source: string | null
  fromTerrain: boolean
}

const DISPLAY_OUTCOME_DOT_COUNT = 256
const EVALUATION_CACHE_NAME = 'looper-live-caddie-evaluations-v3'
const EVALUATION_CACHE_TTL_MS = 10 * 60 * 1000

const displayTierForSurface = (
  kind: CourseSurfaceClassification,
): DecisionRiskTailLanding['tier'] => {
  if (kind === 'water' || kind === 'penalty') return 'catastrophe'
  if (kind === 'bunker' || kind === 'deep-rough') return 'serious_trouble'
  if (kind === 'rough') return 'manageable'
  if (kind === 'unknown') return 'unknown'
  return 'success'
}

const sampleEvenly = <T,>(items: readonly T[], count: number): T[] => {
  if (count <= 0 || items.length === 0) return []
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.min(
      items.length - 1,
      Math.floor(((index + 0.5) * items.length) / count),
    )
    return items[sourceIndex]
  })
}

const sampleWeightedTail = (
  items: readonly DecisionRiskTailLanding[],
  count: number,
): DecisionRiskTailLanding[] => {
  if (count <= 0 || items.length === 0) return []
  const totalWeight = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0)
  if (totalWeight <= 0) return sampleEvenly(items, count)

  const sampled: DecisionRiskTailLanding[] = []
  let sourceIndex = 0
  let cumulative = Math.max(0, items[0].weight)
  for (let index = 0; index < count; index += 1) {
    const target = ((index + 0.5) / count) * totalWeight
    while (sourceIndex < items.length - 1 && cumulative < target) {
      sourceIndex += 1
      cumulative += Math.max(0, items[sourceIndex].weight)
    }
    sampled.push(items[sourceIndex])
  }
  return sampled
}

/**
 * Live Caddie does not need all 2,048 modeled core samples, but a small visual
 * sample makes the percentage outcomes understandable on the course map.
 * Build a deterministic 256-dot approximation of the same full-risk mixture:
 * modeled core mass + the empirically learned planning-excluded tail.
 *
 * The worker reuses `tailLandings` only as a lightweight transport slot for the
 * playing UI. Ranking and all percentages were already computed from the full
 * canonical distributions before this display-only transformation.
 */
const buildDisplayOutcomeDots = (
  candidate: AimCandidateEvaluation,
): DecisionRiskTailLanding[] => {
  const risk = candidate.riskProfile
  if (!risk || candidate.modeledSamples.length === 0) return []

  const coreCount = Math.max(
    0,
    Math.min(
      DISPLAY_OUTCOME_DOT_COUNT,
      Math.round(DISPLAY_OUTCOME_DOT_COUNT * risk.coreProbability),
    ),
  )
  const tailCount = DISPLAY_OUTCOME_DOT_COUNT - coreCount
  const displayWeight = risk.tailProbability > 0
    ? risk.tailProbability / DISPLAY_OUTCOME_DOT_COUNT
    : 0

  const coreDots = sampleEvenly(candidate.modeledSamples, coreCount).map(
    (sample): DecisionRiskTailLanding => ({
      landing: sample.landing,
      kind: sample.kind,
      tier: displayTierForSurface(sample.kind),
      quality: 'normal',
      state: sample.state,
      weight: displayWeight,
    }),
  )

  const tailDots = sampleWeightedTail(risk.tailLandings, tailCount).map(
    (sample): DecisionRiskTailLanding => ({
      ...sample,
      weight: displayWeight,
    }),
  )

  return [...coreDots, ...tailDots]
}

const stripHeavySamples = (evaluations: ClubAimEvaluation[]): ClubAimEvaluation[] =>
  evaluations.map((evaluation) => {
    const candidates = evaluation.candidates.map((candidate) => {
      // Preserve the authoritative compact next-state summary BEFORE removing
      // the 2,048-point core cloud. This keeps expected leave / projected strokes
      // exact in the browser without transporting the heavy sample payload.
      const stateValue = nextStateValueForAimCandidate(candidate)
      const showableOutcomeDots = (candidate.decisionRank ?? Number.POSITIVE_INFINITY) <= 4
        ? buildDisplayOutcomeDots(candidate)
        : []
      return {
        ...candidate,
        stateValue,
        // Keep only a small full-risk display cloud for the top playable lines.
        // Sending every 2,048-point core cloud for every club/aim would make the
        // worker response unnecessarily large and expensive to structured-clone.
        modeledSamples: [],
        riskProfile: candidate.riskProfile
          ? {
              ...candidate.riskProfile,
              tailLandings: showableOutcomeDots,
            }
          : null,
      }
    })
    const bestAimOffset = evaluation.bestCandidate?.aimOffsetYds ?? null
    const bestCandidate = bestAimOffset == null
      ? null
      : candidates.find((candidate) => candidate.aimOffsetYds === bestAimOffset) ?? null

    return {
      ...evaluation,
      candidates,
      bestCandidate,
    }
  })

const pointUnit = (from: CoursePointYds, to: CoursePointYds): CoursePointYds => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy)
  return length > 1e-9 ? [dx / length, dy / length] : [0, 1]
}

const modeledCarryLandingPoint = (
  evaluation: ClubAimEvaluation,
  ball: CoursePointYds,
): CoursePointYds => {
  const aimPoint = evaluation.bestCandidate?.aimPoint ?? evaluation.planningTarget
  const forward = pointUnit(ball, aimPoint)
  const right: CoursePointYds = [forward[1], -forward[0]]
  return [
    ball[0]
      + forward[0] * evaluation.modeledCarryYds
      + right[0] * evaluation.modeledLateralBiasYds,
    ball[1]
      + forward[1] * evaluation.modeledCarryYds
      + right[1] * evaluation.modeledLateralBiasYds,
  ]
}

const resolveLandingElevation = (
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  evaluation: ClubAimEvaluation,
  environment: AimLabEnvironment,
): LandingElevationResolution => {
  const fallbackDelta =
    typeof environment.elevationDeltaFt === 'number' && Number.isFinite(environment.elevationDeltaFt)
      ? environment.elevationDeltaFt
      : null
  const fallback: LandingElevationResolution = {
    deltaFt: fallbackDelta,
    source: environment.elevationSource ?? null,
    fromTerrain: false,
  }

  const ballTerrain = estimateCourseTerrain(hole, ball)
  if (!ballTerrain) return fallback

  const landing = modeledCarryLandingPoint(evaluation, ball)
  const landingTerrain = estimateCourseTerrain(hole, landing)
  if (!landingTerrain) return fallback

  return {
    deltaFt: landingTerrain.elevationFt - ballTerrain.elevationFt,
    source:
      ballTerrain.source === 'lidar-dem' && landingTerrain.source === 'lidar-dem'
        ? 'modeled carry landing · direct LiDAR DEM'
        : 'modeled carry landing · terrain proxy',
    fromTerrain: true,
  }
}

const sessionsForClub = (sessions: SavedSession[], club: string): SavedSession[] =>
  sessions.map((session) => ({
    ...session,
    shots: session.shots.filter((shot) => shot.club === club),
  }))

const rerankCorrectedClubs = (
  evaluations: LandingElevationAwareEvaluation[],
): LandingElevationAwareEvaluation[] => {
  const reset: LandingElevationAwareEvaluation[] = evaluations.map((evaluation) => ({
    ...evaluation,
    decisionRank: null,
    targetFit: null,
    withinCatastropheGuardrail: null,
    decisionReason: null,
  }))
  const ranked = rankRiskAwareClubChoices(reset)
  ranked.forEach((row) => {
    row.evaluation.decisionRank = row.rank
    row.evaluation.targetFit = row.targetFit
    row.evaluation.withinCatastropheGuardrail = row.withinCatastropheGuardrail
    row.evaluation.decisionReason = row.decisionReason
  })
  return ranked.map((row) => row.evaluation)
}

/**
 * Elevation belongs to the modeled shot, not the shared strategic planning target.
 * Start with the canonical evaluation so we know each club's aim/carry, sample the
 * terrain at that club's modeled carry landing, then rerun only that club with the
 * resolved landing elevation. If the corrected carry moves onto meaningfully
 * different terrain, sample and rerun once more. The normal club ranking is then
 * recomputed across the corrected evaluations.
 */
const resolveClubLandingElevations = (
  sessions: SavedSession[],
  hole: CourseHoleGeometry,
  ball: CoursePointYds,
  target: CoursePointYds,
  environment: AimLabEnvironment,
  nowMs: number,
): LandingElevationAwareEvaluation[] => {
  const baseline = evaluateAimLab(sessions, hole, ball, target, environment, nowMs)

  const corrected = baseline.map((baselineEvaluation): LandingElevationAwareEvaluation => {
    let current = baselineEvaluation
    let resolution = resolveLandingElevation(hole, ball, current, environment)

    if (!resolution.fromTerrain) {
      return {
        ...current,
        landingElevationDeltaFt: resolution.deltaFt,
        landingElevationSource: resolution.source,
      }
    }

    const clubSessions = sessionsForClub(sessions, current.club)
    let appliedResolution = resolution

    for (let iteration = 0; iteration < 2; iteration += 1) {
      appliedResolution = resolution
      const reevaluated = evaluateAimLab(
        clubSessions,
        hole,
        ball,
        target,
        {
          ...environment,
          elevationDeltaFt: appliedResolution.deltaFt,
          elevationSource: appliedResolution.source ?? environment.elevationSource,
        },
        nowMs,
      ).find((evaluation) => evaluation.club === current.club)

      if (!reevaluated) break
      current = reevaluated

      const nextResolution = resolveLandingElevation(hole, ball, current, environment)
      if (
        !nextResolution.fromTerrain
        || nextResolution.deltaFt == null
        || appliedResolution.deltaFt == null
        || Math.abs(nextResolution.deltaFt - appliedResolution.deltaFt) < 1
      ) {
        break
      }
      resolution = nextResolution
    }

    return {
      ...current,
      landingElevationDeltaFt: appliedResolution.deltaFt,
      landingElevationSource: appliedResolution.source,
    }
  })

  return rerankCorrectedClubs(corrected)
}

/**
 * The engine's aim point is intentionally anchored at a shared strategic target
 * so clubs can be ranked against the same state. That point is useful for the
 * optimizer but misleading on the playing map: a 6i should not draw an aim dot
 * out at Driver depth.
 *
 * After ranking is complete, preserve the exact aim ANGLE but move the visible
 * aim point to this club's modeled carry distance. The displayed right/left
 * number is recomputed at that same distance. No ranking, sampling or risk math
 * is changed by this presentation transform.
 */
const makePlayerFacingAimGeometry = (
  evaluations: ClubAimEvaluation[],
  ball: CoursePointYds,
): ClubAimEvaluation[] =>
  evaluations.map((evaluation) => {
    const baseForward = pointUnit(ball, evaluation.planningTarget)
    const baseRight: CoursePointYds = [baseForward[1], -baseForward[0]]
    const displayDistanceYds = Math.max(1, evaluation.modeledCarryYds)
    const bestRank = evaluation.bestCandidate?.decisionRank ?? null

    const candidates = evaluation.candidates.map((candidate) => {
      const aimForward = pointUnit(ball, candidate.aimPoint)
      const displayAimPoint: CoursePointYds = [
        ball[0] + aimForward[0] * displayDistanceYds,
        ball[1] + aimForward[1] * displayDistanceYds,
      ]
      const displayRightYds =
        (displayAimPoint[0] - ball[0]) * baseRight[0]
        + (displayAimPoint[1] - ball[1]) * baseRight[1]

      return {
        ...candidate,
        aimPoint: displayAimPoint,
        aimOffsetYds: displayRightYds,
      }
    })

    const bestCandidate = bestRank == null
      ? null
      : candidates.find((candidate) => candidate.decisionRank === bestRank) ?? null

    return {
      ...evaluation,
      candidates,
      bestCandidate,
    }
  })

const finiteKeyNumber = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : null

const hashString = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const buildEvaluationCacheKey = ({
  sessions,
  hole,
  ball,
  target,
  environment,
}: LiveCaddieWorkerRequest) => {
  const playerSignature = sessions.map((session) => ({
    id: session.id,
    endedAt: session.endedAt,
    includeInAnalysis: session.metadata?.includeInAnalysis ?? null,
    shots: session.shots.map((shot) => [
      shot.id,
      shot.club,
      shot.included,
      shot.capturedAt,
      shot.shotVariantId ?? null,
      shot.feltPerfect ?? null,
      shot.carryYards ?? null,
      shot.totalYards ?? null,
      shot.offlineYards ?? null,
      shot.ballSpeedMph ?? null,
      shot.launchAngleDeg ?? null,
      shot.spinRpm ?? null,
      shot.spinAxisDegrees ?? null,
      shot.clubPathDeg ?? shot.clubPathDegrees ?? null,
      shot.clubAoa ?? null,
    ]),
  }))

  const geometrySignature = {
    courseId: hole.courseId,
    holeNumber: hole.holeNumber,
    bounds: hole.bounds,
    surfaces: hole.surfaces.map((surface) => [
      surface.id,
      surface.kind,
      surface.polygons.length,
    ]),
    context: hole.contextLayers?.map((layer) => [layer.id, layer.kind, layer.polygons.length]) ?? [],
    terrain: hole.terrain
      ? [
          hole.terrain.width,
          hole.terrain.height,
          hole.terrain.runtimeSpacingYds,
          hole.terrain.elevationOffsetFt,
        ]
      : null,
    sourceBaseTimestamp: hole.provenance.sourceBaseTimestamp ?? null,
    fetchedAt: hole.provenance.fetchedAt ?? null,
  }

  const stateSignature = JSON.stringify({
    playerSignature,
    geometrySignature,
    ball: [finiteKeyNumber(ball[0]), finiteKeyNumber(ball[1])],
    target: [finiteKeyNumber(target[0]), finiteKeyNumber(target[1])],
    environment: {
      windMph: finiteKeyNumber(environment.windMph),
      windRelativeDeg: finiteKeyNumber(environment.windRelativeDeg),
      elevationDeltaFt: finiteKeyNumber(environment.elevationDeltaFt),
      airAltitudeFt: finiteKeyNumber(environment.airAltitudeFt),
      surfaceOverride: environment.surfaceOverride ?? null,
    },
  })

  return hashString(stateSignature)
}

const cacheStorage = () => (
  globalThis as unknown as {
    caches?: {
      open: (name: string) => Promise<{
        match: (request: Request) => Promise<Response | undefined>
        put: (request: Request, response: Response) => Promise<void>
      }>
    }
  }
).caches

const cacheRequestForKey = (key: string) =>
  new Request(`https://looper.local/live-caddie-evaluation/${key}`)

const readCachedEvaluations = async (key: string): Promise<ClubAimEvaluation[] | null> => {
  const storage = cacheStorage()
  if (!storage) return null
  try {
    const cache = await storage.open(EVALUATION_CACHE_NAME)
    const response = await cache.match(cacheRequestForKey(key))
    if (!response) return null
    const payload = await response.json() as CachedEvaluationPayload
    if (
      typeof payload.cachedAt !== 'number'
      || Date.now() - payload.cachedAt > EVALUATION_CACHE_TTL_MS
      || !Array.isArray(payload.evaluations)
    ) {
      return null
    }
    return payload.evaluations
  } catch {
    return null
  }
}

const writeCachedEvaluations = async (
  key: string,
  evaluations: ClubAimEvaluation[],
) => {
  const storage = cacheStorage()
  if (!storage) return
  try {
    const cache = await storage.open(EVALUATION_CACHE_NAME)
    const payload: CachedEvaluationPayload = {
      cachedAt: Date.now(),
      evaluations,
    }
    await cache.put(
      cacheRequestForKey(key),
      new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
      }),
    )
  } catch {
    // Evaluation remains fully functional if browser cache storage is unavailable.
  }
}

self.onmessage = (event: MessageEvent<LiveCaddieWorkerRequest>) => {
  void (async () => {
    try {
      const request = event.data
      const cacheKey = buildEvaluationCacheKey(request)
      const cached = await readCachedEvaluations(cacheKey)
      if (cached) {
        const response: LiveCaddieWorkerResponse = { type: 'success', evaluations: cached }
        self.postMessage(response)
        return
      }

      const { sessions, hole, ball, target, environment, nowMs } = request
      const evaluations = makePlayerFacingAimGeometry(
        stripHeavySamples(
          resolveClubLandingElevations(sessions, hole, ball, target, environment, nowMs),
        ),
        ball,
      )
      await writeCachedEvaluations(cacheKey, evaluations)
      const response: LiveCaddieWorkerResponse = { type: 'success', evaluations }
      self.postMessage(response)
    } catch (cause) {
      const response: LiveCaddieWorkerResponse = {
        type: 'error',
        error: cause instanceof Error ? cause.message : String(cause),
      }
      self.postMessage(response)
    }
  })()
}

export {}
