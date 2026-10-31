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

export const getSurfaceResponse = (surface: string | null | undefined): SurfaceResponse => {
  const value = normalize(surface)

  if (value === 'fairway' || value === 'tee') return GSProSurfaceResponses.baseline
  if (value === 'rough' || value === 'semirough' || value === 'semi-rough') return withLearned(GSProSurfaceResponses.rough)
  if (value === 'deep-rough' || value === 'deeprough') return withLearned(GSProSurfaceResponses['deep-rough'])
  if (value === 'sand' || value === 'bunker' || value === 'tvgsand') return withLearned(GSProSurfaceResponses.sand)

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
