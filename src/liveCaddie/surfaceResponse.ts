export type ModeledSurfaceKind = 'baseline' | 'rough' | 'deep-rough' | 'sand' | 'unknown'

export type SurfaceLaunchFactors = {
  speed: number
  spin: number
  vla: number
}

export type SurfaceResponse = {
  kind: ModeledSurfaceKind
  label: string
  factors: SurfaceLaunchFactors
  modeled: boolean
  evidence: string
}

const BASELINE_FACTORS: SurfaceLaunchFactors = {
  speed: 1,
  spin: 1,
  vla: 1,
}

/**
 * GSPro surface modifiers observed in prior output_log research.
 *
 * Rough and deep rough were stable observed values. Sand varied only slightly
 * across observed lies, so V1 intentionally uses the midpoint of the observed
 * ranges rather than pretending to model that small per-shot variation.
 *
 * These factors modify the representative Stock launch packet. The resulting
 * flight delta is then applied to measured Stock carry; absolute simulated carry
 * never replaces the player's observed baseline.
 */
export const GSProSurfaceResponses = {
  baseline: {
    kind: 'baseline',
    label: 'Fairway / tee',
    factors: BASELINE_FACTORS,
    modeled: true,
    evidence: 'Baseline playable surface; no GSPro launch penalty.',
  },
  rough: {
    kind: 'rough',
    label: 'Rough',
    factors: { speed: 0.96, spin: 0.61, vla: 1 },
    modeled: true,
    evidence: 'Observed GSPro penalty: Speed 96%, Spin 61%, VLA 100%.',
  },
  'deep-rough': {
    kind: 'deep-rough',
    label: 'Deep rough',
    factors: { speed: 0.82, spin: 0.49, vla: 0.98 },
    modeled: true,
    evidence: 'Observed GSPro penalty: Speed 82%, Spin 49%, VLA 98%.',
  },
  sand: {
    kind: 'sand',
    label: 'Sand / bunker',
    factors: { speed: 0.77, spin: 0.765, vla: 1 },
    modeled: true,
    evidence: 'Observed GSPro ranges: Speed 76–78%, Spin 75–78%, VLA 100%; midpoint used.',
  },
} as const satisfies Record<Exclude<ModeledSurfaceKind, 'unknown'>, SurfaceResponse>

const normalize = (surface: string | null | undefined) =>
  surface?.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-') ?? ''

type LearnedKind = 'rough' | 'deep-rough' | 'sand'
let learnedFactors: Partial<Record<LearnedKind, SurfaceLaunchFactors & { samples: number }>> = {}

/**
 * The golfer's own GSPro penalties (median per lie, from output_log; see
 * adapters/gsproPenaltyLog.ts). Set on the main thread and in the decision
 * worker before evaluating. Values outside 50-105% are ignored.
 */
export const setLearnedSurfaceFactors = (
  value: Partial<Record<LearnedKind, SurfaceLaunchFactors & { samples: number }>> | null | undefined,
) => {
  const ok = (f: SurfaceLaunchFactors & { samples: number }) =>
    [f.speed, f.spin, f.vla].every((x) => Number.isFinite(x) && x >= 0.5 && x <= 1.05) && f.samples >= 2
  learnedFactors = {}
  for (const kind of ['rough', 'deep-rough', 'sand'] as const) {
    const f = value?.[kind]
    if (f && ok(f)) learnedFactors[kind] = f
  }
}

const withLearned = (base: SurfaceResponse & { kind: LearnedKind }): SurfaceResponse => {
  const learned = learnedFactors[base.kind]
  if (!learned) return base
  const pctText = (x: number) => `${Math.round(x * 100)}%`
  return {
    ...base,
    factors: { speed: learned.speed, spin: learned.spin, vla: learned.vla },
    evidence: `Your GSPro shots (${learned.samples}): Speed ${pctText(learned.speed)}, Spin ${pctText(learned.spin)}, VLA ${pctText(learned.vla)} (median from GSPro's log).`,
  }
}

/**
 * GSPro's sand penalty depends on how hard the ball is hit. Across players'
 * rounds (55 sand shots, 5 players, GSPro's speed after the lie against the
 * launch monitor's raw speed, 18 Nov 2026): shots under 45 mph keep 76% of
 * their speed, 45-70 mph keep 86%, and anything over 70 mph keeps 93%, tightly.
 * A fixed 77% (greenside blasts) made a 7-iron from a fairway bunker look
 * 60 yd short; a player trusted it and flew the green by 25.
 */
const SAND_SLOW_MPH = 40
const SAND_FULL_MPH = 70
const SAND_SLOW_SPEED = 0.757
const SAND_FULL_SPEED = 0.93

export const sandSpeedFactor = (ballSpeedMph: number) => {
  const t = Math.min(1, Math.max(0, (ballSpeedMph - SAND_SLOW_MPH) / (SAND_FULL_MPH - SAND_SLOW_MPH)))
  return SAND_SLOW_SPEED + (SAND_FULL_SPEED - SAND_SLOW_SPEED) * t
}

const sandResponse = (ballSpeedMph: number | null | undefined): SurfaceResponse => {
  const base = withLearned(GSProSurfaceResponses.sand)
  if (!(typeof ballSpeedMph === 'number' && Number.isFinite(ballSpeedMph) && ballSpeedMph > 0)) return base
  // The speed penalty follows the shot, not a per-player median (which is mostly greenside blasts).
  const speed = sandSpeedFactor(ballSpeedMph)
  const pctText = (x: number) => `${Math.round(x * 100)}%`
  return {
    ...base,
    label: ballSpeedMph >= SAND_FULL_MPH ? 'Sand / fairway bunker' : base.label,
    factors: { ...base.factors, speed },
    evidence: `GSPro's sand penalty by shot speed: Speed ${pctText(speed)} at ${Math.round(ballSpeedMph)} mph `
      + `(76% for short blasts, 93% for full shots), Spin ${pctText(base.factors.spin)}, VLA ${pctText(base.factors.vla)}.`,
  }
}

/**
 * `ballSpeedMph` is the club's stock ball speed for the shot being planned;
 * it only matters from sand. Without it sand keeps the greenside figure.
 */
export const getSurfaceResponse = (surface: string | null | undefined, ballSpeedMph?: number | null): SurfaceResponse => {
  const value = normalize(surface)

  if (value === 'fairway' || value === 'tee') return GSProSurfaceResponses.baseline
  if (value === 'rough' || value === 'semirough' || value === 'semi-rough') return withLearned(GSProSurfaceResponses.rough)
  if (value === 'deep-rough' || value === 'deeprough') return withLearned(GSProSurfaceResponses['deep-rough'])
  if (value === 'sand' || value === 'bunker' || value === 'tvgsand') return sandResponse(ballSpeedMph)

  return {
    kind: 'unknown',
    label: surface?.trim() || 'Unknown surface',
    factors: BASELINE_FACTORS,
    modeled: false,
    evidence: 'No validated GSPro launch modifier encoded for this surface.',
  }
}

export const applySurfaceLaunchFactors = <T extends {
  ballSpeedMph: number
  vlaDeg: number
  totalSpinRpm: number
}>(launch: T, response: SurfaceResponse): T => ({
  ...launch,
  ballSpeedMph: launch.ballSpeedMph * response.factors.speed,
  vlaDeg: launch.vlaDeg * response.factors.vla,
  totalSpinRpm: launch.totalSpinRpm * response.factors.spin,
})
