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
  const spin = sandSpinFactor(ballSpeedMph)
  return {
    ...base,
    label: ballSpeedMph >= SAND_FULL_MPH ? 'Sand / fairway bunker' : base.label,
    factors: { ...base.factors, speed, spin },
    evidence: `GSPro's sand penalty by shot speed: Speed ${pctText(speed)} at ${Math.round(ballSpeedMph)} mph `
      + `(76% for short blasts, 93% for full shots), Spin ${pctText(spin)}, VLA ${pctText(base.factors.vla)}.`,
  }
}

/**
 * Spin from sand (GSPro's own penalty line, 18 Nov 2026): full shots keep all
 * of it, a 50 mph shot keeps 90%. Short blasts keep the older 76%.
 */
export const sandSpinFactor = (ballSpeedMph: number) => {
  if (ballSpeedMph >= SAND_FULL_MPH) return 1
  if (ballSpeedMph >= 50) return 0.9 + 0.1 * (ballSpeedMph - 50) / (SAND_FULL_MPH - 50)
  return 0.765 + (0.9 - 0.765) * Math.min(1, Math.max(0, (ballSpeedMph - SAND_SLOW_MPH) / (50 - SAND_SLOW_MPH)))
}

export type SurfaceLaunch = Readonly<{ ballSpeedMph?: number | null; vlaDeg?: number | null; totalSpinRpm?: number | null }>

const held = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
const usable = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/**
 * GSPro's rough and deep rough penalties follow the shot, not the lie alone.
 *
 * Measured from GSPro's own penalty line (On Course practice, 18 Nov 2026, no
 * swings): 19 different launches from deep rough and 21 from rough, on four
 * courses. The speed kept falls as the launch gets lower: from deep rough a
 * lob wedge keeps 81% and a 3-hybrid 64% (it carried 92 yd of a clean 197).
 * A fixed 82% was right for wedges only. Ball speed matters a little; spin
 * hardly at all. Holding each launch out of the fit, the speed kept is
 * predicted to 0.9 points in deep rough (3 at worst) and 0.4 in rough.
 */
export const deepRoughFactors = (launch: { ballSpeedMph: number; vlaDeg: number }): SurfaceLaunchFactors => ({
  speed: held(0.88388 - 1.76856 / held(launch.vlaDeg, 6, 45) - 0.00029 * launch.ballSpeedMph, 0.6, 0.82),
  spin: held(0.49357 + 0.00049 * launch.ballSpeedMph, 0.48, 0.57),
  vla: 0.98,
})

export const roughFactors = (launch: { ballSpeedMph: number; vlaDeg: number }): SurfaceLaunchFactors => {
  const vla = held(launch.vlaDeg, 6, 45)
  return {
    speed: held(0.9813 - 0.27366 / vla - 0.00024 * launch.ballSpeedMph, 0.9, 0.975),
    spin: held(0.72803 - 0.02374 * Math.log(vla) + 0.00112 * launch.ballSpeedMph, 0.64, 0.82),
    vla: 1,
  }
}

/** The first cut: GSPro takes 1.5% of the speed and 5% of the spin, the same for every shot measured. */
const SEMI_ROUGH_RESPONSE: SurfaceResponse = {
  kind: 'rough',
  label: 'Semi-rough',
  factors: { speed: 0.985, spin: 0.95, vla: 1 },
  modeled: true,
  evidence: 'GSPro penalty measured 18 Nov 2026: Speed 98.5%, Spin 95%, VLA 100% for every shot.',
}

const byLaunch = (base: SurfaceResponse & { kind: 'rough' | 'deep-rough' }, launch: SurfaceLaunch | null): SurfaceResponse => {
  if (!launch || !usable(launch.ballSpeedMph) || !usable(launch.vlaDeg)) return withLearned(base)
  const shot = { ballSpeedMph: launch.ballSpeedMph, vlaDeg: launch.vlaDeg }
  const factors = base.kind === 'deep-rough' ? deepRoughFactors(shot) : roughFactors(shot)
  const pctText = (x: number) => `${Math.round(x * 100)}%`
  return {
    ...base,
    factors,
    evidence: `GSPro's ${base.label.toLowerCase()} penalty for this shot (${Math.round(shot.ballSpeedMph)} mph, ${shot.vlaDeg.toFixed(0)}° launch): `
      + `Speed ${pctText(factors.speed)}, Spin ${pctText(factors.spin)}, VLA ${pctText(factors.vla)}. Lower launches lose more.`,
  }
}

/**
 * `shot` is the club's stock launch for the shot being planned (or just its
 * ball speed). GSPro's penalty from rough, deep rough and sand depends on it;
 * without it each lie keeps one fixed figure.
 */
export const getSurfaceResponse = (surface: string | null | undefined, shot?: SurfaceLaunch | number | null): SurfaceResponse => {
  const value = normalize(surface)
  const launch: SurfaceLaunch | null = typeof shot === 'number' ? { ballSpeedMph: shot } : shot ?? null

  if (value === 'fairway' || value === 'tee') return GSProSurfaceResponses.baseline
  if (value === 'semirough' || value === 'semi-rough' || value === 'tvgsemirough') return SEMI_ROUGH_RESPONSE
  if (value === 'rough' || value === 'tvgrough') return byLaunch(GSProSurfaceResponses.rough, launch)
  if (value === 'deep-rough' || value === 'deeprough' || value === 'tvgdeeprough') return byLaunch(GSProSurfaceResponses['deep-rough'], launch)
  if (value === 'sand' || value === 'bunker' || value === 'tvgsand') return sandResponse(launch?.ballSpeedMph)

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
