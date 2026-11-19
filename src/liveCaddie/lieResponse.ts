import { simulateFlight, type FlightEnvironmentInput, type FlightLaunchInput } from './flightPhysics'
import { gsproCarryRatio } from './gsproCarryModel'

export const SIDEHILL_LIE_MODEL_VERSION = 'looper-sidehill-lie-gspro-v1'
export const UPDOWN_LIE_MODEL_VERSION = 'looper-updown-lie-gspro-v1'
/** Guard on the flight model's answer, as a share of stock carry (a hybrid off a steep downslope loses a lot). */
export const UPDOWN_LIE_MAX_CARRY_FRACTION = 0.25
export const UPDOWN_LIE_MAX_VLA_DELTA_DEG = 16

/**
 * What GSPro does with the slope of the lie, measured from its own flight paths
 * (On Course practice, 18 Nov 2026: 122 shots from slopes of 0.2 to 29 degrees
 * on five courses, sent dead straight with no swing).
 *
 * It turns the launch by a share of the slope, and the share is bigger the
 * lower the ball launches:
 *   up or down:  launch angle moves by slope x (0.834 - 0.0141 x launch)
 *   left / right: start line moves by slope x (1.150 - 0.0237 x launch)
 * A driver gets about 0.7 of an uphill and 0.9 of a sidehill; a lob wedge 0.4
 * of each. Fitted to 0.3 deg of launch and 0.05 deg of start line on average.
 * Before this Looper used 0.25 of an uphill (capped at 3 deg) and a loft-based
 * sidehill figure that grew with loft, the opposite of GSPro.
 */
const share = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
export const upDownLieShare = (launchVlaDeg: number) => share(0.83419 - 0.01414 * launchVlaDeg, 0.2, 0.9)
export const sidehillLieShare = (launchVlaDeg: number) => share(1.15031 - 0.02374 * launchVlaDeg, 0.2, 1)
/** Launch angle from loft when the club's launch is not known: about half the loft, never under a driver's. */
const launchFromLoft = (loftDeg: number) => Math.max(9, loftDeg * 0.5)

export type SidehillLieResponse = {
  status: 'ready' | 'unavailable'
  modelVersion: string
  gain: number
  clubLoftDeg: number | null
  lieLeftRightDeg: number | null
  /** The side slope as a start-line tendency before the share (+ = GSPro Left). */
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
  /** The club's launch angle; without it the launch is taken as half the loft. */
  launchVlaDeg?: number | null
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const degToRad = (value: number) => value * Math.PI / 180

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
 * Sidehill: the start line turns toward the low side by a share of the slope.
 *
 * Looper convention:
 *   lieLeftRightDeg > 0 means GSPro "Left"; the ball starts left.
 *   Course lateral coordinates use +right / -left.
 */
export const buildSidehillLieResponse = ({
  club,
  clubLoftDeg,
  lieLeftRightDeg,
  carryYds,
  launchVlaDeg,
}: SidehillLieInput): SidehillLieResponse => {
  const resolvedLoft = resolveSidehillClubLoftDeg(club, clubLoftDeg)
  const launchDeg = finite(launchVlaDeg) && launchVlaDeg > 0 && launchVlaDeg < 60
    ? launchVlaDeg
    : resolvedLoft != null ? launchFromLoft(resolvedLoft) : null
  const gain = launchDeg == null ? 0 : sidehillLieShare(launchDeg)
  if (!finite(lieLeftRightDeg) || !finite(carryYds) || carryYds <= 0 || launchDeg == null) {
    return {
      status: 'unavailable',
      modelVersion: SIDEHILL_LIE_MODEL_VERSION,
      gain,
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
  const geometryBiasDeg = boundedLieDeg
  const appliedBiasDeg = -gain * geometryBiasDeg
  const lateralDeltaYds = carryYds * Math.tan(degToRad(appliedBiasDeg))

  return {
    status: 'ready',
    modelVersion: SIDEHILL_LIE_MODEL_VERSION,
    gain,
    clubLoftDeg: resolvedLoft,
    lieLeftRightDeg,
    geometryBiasDeg,
    appliedBiasDeg,
    lateralDeltaYds,
  }
}

export type UpDownLieResponse = {
  status: 'ready' | 'unavailable'
  modelVersion: string
  gain: number
  lieUpDownDeg: number | null
  appliedVlaDeltaDeg: number
  rawCarryDeltaYds: number
  carryCapYds: number
  carryDeltaYds: number
}

type UpDownLieInput = {
  launch: FlightLaunchInput | null
  environment?: FlightEnvironmentInput
  lieUpDownDeg?: number | null
  stockCarryYds?: number | null
}

/**
 * Uphill and downhill lies.
 *
 * GSPro convention:
 *   lieUpDownDeg > 0 = Up, which raises the launch; < 0 = Down, which lowers it.
 *
 * The launch angle moves by GSPro's measured share of the slope for this
 * launch. The adjusted launch is flown through the flight model under the
 * current environment, and the carry change is held to a quarter of stock
 * carry as a guard on the flight model.
 */
export const buildUpDownLieResponse = ({
  launch,
  environment = {},
  lieUpDownDeg,
  stockCarryYds,
}: UpDownLieInput): UpDownLieResponse => {
  const finiteStockCarry = finite(stockCarryYds) && stockCarryYds > 0
    ? stockCarryYds
    : null
  const carryCapYds = finiteStockCarry == null
    ? 0
    : finiteStockCarry * UPDOWN_LIE_MAX_CARRY_FRACTION

  const gain = launch && finite(launch.vlaDeg) ? upDownLieShare(launch.vlaDeg) : 0
  if (!launch || !finite(lieUpDownDeg) || finiteStockCarry == null) {
    return {
      status: 'unavailable',
      modelVersion: UPDOWN_LIE_MODEL_VERSION,
      gain,
      lieUpDownDeg: finite(lieUpDownDeg) ? lieUpDownDeg : null,
      appliedVlaDeltaDeg: 0,
      rawCarryDeltaYds: 0,
      carryCapYds,
      carryDeltaYds: 0,
    }
  }

  const boundedLieDeg = Math.max(-25, Math.min(25, lieUpDownDeg))
  const appliedVlaDeltaDeg = Math.max(
    -UPDOWN_LIE_MAX_VLA_DELTA_DEG,
    Math.min(UPDOWN_LIE_MAX_VLA_DELTA_DEG, boundedLieDeg * gain),
  )

  const baseline = simulateFlight(launch, environment)
  const adjusted = simulateFlight({
    ...launch,
    vlaDeg: Math.max(0.2, launch.vlaDeg + appliedVlaDeltaDeg),
  }, environment)

  if (!baseline.ok || !adjusted.ok || !finite(baseline.carryYds) || !finite(adjusted.carryYds)) {
    return {
      status: 'unavailable',
      modelVersion: UPDOWN_LIE_MODEL_VERSION,
      gain,
      lieUpDownDeg,
      appliedVlaDeltaDeg,
      rawCarryDeltaYds: 0,
      carryCapYds,
      carryDeltaYds: 0,
    }
  }

  // GSPro's own carry for the turned launch against the original, when both are inside what was
  // measured; the flight model's change, as a share of its own carry, otherwise.
  const measuredRatio = gsproCarryRatio(launch, { ...launch, vlaDeg: launch.vlaDeg + appliedVlaDeltaDeg })
  const rawCarryDeltaYds = measuredRatio != null
    ? finiteStockCarry * (measuredRatio - 1)
    : baseline.carryYds > 1 ? finiteStockCarry * (adjusted.carryYds / baseline.carryYds - 1) : adjusted.carryYds - baseline.carryYds
  const carryDeltaYds = Math.max(-carryCapYds, Math.min(carryCapYds, rawCarryDeltaYds))

  return {
    status: 'ready',
    modelVersion: UPDOWN_LIE_MODEL_VERSION,
    gain,
    lieUpDownDeg,
    appliedVlaDeltaDeg,
    rawCarryDeltaYds,
    carryCapYds,
    carryDeltaYds,
  }
}
