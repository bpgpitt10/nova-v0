export const SIDEHILL_LIE_MODEL_VERSION = 'looper-sidehill-lie-prior-v0.1'

/**
 * Intentionally conservative starting prior. The geometric effect is physically
 * motivated, but GSPro's actual response has not been isolated yet. Keep this
 * coefficient explicit so later Open Connect validation can fit it without
 * changing the decision engine.
 */
export const SIDEHILL_LIE_GAIN = 0.5

export type SidehillLieResponse = {
  status: 'ready' | 'unavailable'
  modelVersion: string
  gain: number
  clubLoftDeg: number | null
  lieLeftRightDeg: number | null
  /** Raw loft-aware geometric start-line tendency before the conservative gain. */
  geometryBiasDeg: number
  /** Applied shot-center tendency. Positive = right, negative = left. */
  appliedBiasDeg: number
  /** Applied shot-center shift at modeled carry. Positive = right, negative = left. */
  lateralDeltaYds: number
}

type SidehillLieInput = {
  club?: string | null
  clubLoftDeg?: number | null
  lieLeftRightDeg?: number | null
  carryYds?: number | null
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const degToRad = (value: number) => value * Math.PI / 180
const radToDeg = (value: number) => value * 180 / Math.PI

/**
 * Nominal lofts are only a fallback until bag-specific loft is part of the
 * player profile. They are deliberately centralized here so club specs can
 * replace them later without touching aim/risk logic.
 */
const NOMINAL_CLUB_LOFT_DEG: Readonly<Record<string, number>> = {
  Driver: 10.5,
  'Mini Driver': 13.5,
  '2W': 13,
  '3W': 15,
  '4W': 16.5,
  '5W': 18,
  '7W': 21,
  '9W': 24,
  '2H': 17,
  '3H': 19,
  '4H': 22,
  '5H': 25,
  '6H': 28,
  '7H': 31,
  '1i': 16,
  '2i': 18,
  '3i': 20,
  '4i': 23,
  '5i': 26,
  '6i': 29,
  '7i': 33,
  '8i': 37,
  '9i': 41,
  PW: 45,
  AW: 48,
  GW: 50,
  SW: 54,
  LW: 58,
}

export const resolveSidehillClubLoftDeg = (
  club: string | null | undefined,
  explicitLoftDeg?: number | null,
) => {
  if (finite(explicitLoftDeg) && explicitLoftDeg > 0 && explicitLoftDeg < 80) {
    return explicitLoftDeg
  }
  if (!club) return null
  return NOMINAL_CLUB_LOFT_DEG[club] ?? null
}

/**
 * V0 sidehill response.
 *
 * Geometry:
 *   faceShift = atan(tan(loft) * sin(sideSlope))
 *
 * Looper convention:
 *   lieLeftRightDeg > 0 means GSPro "Left" / ball above feet.
 *   Course lateral coordinates use +right / -left.
 * Therefore a positive GSPro Left lie creates a negative lateral shot-center
 * shift. The 0.50 gain is applied after the geometric calculation.
 *
 * Up/down lie is intentionally excluded here. It remains measurement-only until
 * we validate its carry/VLA response separately.
 */
export const buildSidehillLieResponse = ({
  club,
  clubLoftDeg,
  lieLeftRightDeg,
  carryYds,
}: SidehillLieInput): SidehillLieResponse => {
  const resolvedLoft = resolveSidehillClubLoftDeg(club, clubLoftDeg)
  if (!finite(lieLeftRightDeg) || !finite(carryYds) || carryYds <= 0 || resolvedLoft == null) {
    return {
      status: 'unavailable',
      modelVersion: SIDEHILL_LIE_MODEL_VERSION,
      gain: SIDEHILL_LIE_GAIN,
      clubLoftDeg: resolvedLoft,
      lieLeftRightDeg: finite(lieLeftRightDeg) ? lieLeftRightDeg : null,
      geometryBiasDeg: 0,
      appliedBiasDeg: 0,
      lateralDeltaYds: 0,
    }
  }

  // Avoid pathological values from malformed state while preserving every
  // realistic simulator lie. GSPro course lies should live well inside ±25°.
  const boundedLieDeg = Math.max(-25, Math.min(25, lieLeftRightDeg))
  const geometryBiasDeg = radToDeg(Math.atan(
    Math.tan(degToRad(resolvedLoft)) * Math.sin(degToRad(boundedLieDeg)),
  ))
  const appliedBiasDeg = -SIDEHILL_LIE_GAIN * geometryBiasDeg
  const lateralDeltaYds = carryYds * Math.tan(degToRad(appliedBiasDeg))

  return {
    status: 'ready',
    modelVersion: SIDEHILL_LIE_MODEL_VERSION,
    gain: SIDEHILL_LIE_GAIN,
    clubLoftDeg: resolvedLoft,
    lieLeftRightDeg,
    geometryBiasDeg,
    appliedBiasDeg,
    lateralDeltaYds,
  }
}
