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

export const getSurfaceResponse = (surface: string | null | undefined): SurfaceResponse => {
  const value = normalize(surface)

  if (value === 'fairway' || value === 'tee') return GSProSurfaceResponses.baseline
  if (value === 'rough' || value === 'semirough' || value === 'semi-rough') return GSProSurfaceResponses.rough
  if (value === 'deep-rough' || value === 'deeprough') return GSProSurfaceResponses['deep-rough']
  if (value === 'sand' || value === 'bunker' || value === 'tvgsand') return GSProSurfaceResponses.sand

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
