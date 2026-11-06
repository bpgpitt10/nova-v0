import { sortClubIds, type Club } from './bagConfig'

/**
 * Quick Bag: a starting set of club numbers from three carries and a handicap,
 * so Live Caddie works on the first hole instead of after sixty range balls.
 *
 * The player types the carry and shape (draw / neutral / fade-or-slice) of the
 * Driver, 7-iron and PW. From the handicap come the dispersion and the mishit
 * rate; from the three carries the gapping of every other club; from standard
 * per-club tables the launch (ball speed, spin, height) that wind and altitude
 * need. Every number is a *prior*: as the player hits range balls each club
 * blends toward its own data and hands over entirely at a shot count that
 * depends on the number (Brian, 11/6: a carry average is believable after
 * five swings; a dispersion is not):
 *
 *   carry mean       prior worth 2 shots, fully range at 5
 *   lateral bias     prior worth 3,  fully range at 8
 *   carry / lateral σ prior worth 6, fully range at 12
 *   mishit tail      prior worth 10, fully range at 20
 *
 * Right-handed by default: a draw finishes left (negative offline).
 */

export type ShotShape = 'draw' | 'neutral' | 'fade'
export type AnchorClub = 'Driver' | '7i' | 'PW'
export const ANCHOR_CLUBS: readonly AnchorClub[] = ['Driver', '7i', 'PW']

export type QuickBagAnchor = Readonly<{ carryYds: number; shape: ShotShape }>

export type QuickBagInput = Readonly<{
  version: 1
  /** 0–36; null = didn't say (treated as 18). */
  handicap: number | null
  anchors: Readonly<Record<AnchorClub, QuickBagAnchor>>
  /** The clubs in the bag (from the bag setup); the prior covers each one. */
  clubs: readonly Club[]
  /** Carries the player typed over the gapped guess, per club (Brian, 11/6: edit the whole bag in quick mode). */
  carryOverrides?: Readonly<Partial<Record<Club, number>>>
  handed: 'right' | 'left'
  savedAt: string
}>

export type QuickBagClubPrior = Readonly<{
  club: Club
  carryYds: number
  totalYds: number
  carrySigmaYds: number
  totalSigmaYds: number
  lateralBiasYds: number
  lateralSigmaYds: number
  /** Share of swings that come up well short (carry loss ≥ 8%). */
  mishitRate: number
  /** Of those, the share that are severe (≥ 20% short). */
  severeShare: number
  launch: Readonly<{
    ballSpeedMph: number
    vlaDeg: number
    totalSpinRpm: number
    peakHeightYds: number
    descentAngleDeg: number
  }>
}>

export type QuickBagPrior = Readonly<{
  input: QuickBagInput
  handicap: number
  clubs: readonly QuickBagClubPrior[]
}>

export const DEFAULT_HANDICAP = 18

// ---------------------------------------------------------------- blending

export type BlendRule = Readonly<{ priorShots: number; fullAt: number }>
export const BLEND_RULES = {
  carry: { priorShots: 2, fullAt: 5 },
  lateralBias: { priorShots: 3, fullAt: 8 },
  sigma: { priorShots: 6, fullAt: 12 },
  mishit: { priorShots: 10, fullAt: 20 },
} as const satisfies Record<string, BlendRule>

/** Weight on the range data (0 = all prior, 1 = all range). */
export const rangeWeight = (shots: number, rule: BlendRule): number => {
  if (shots <= 0) return 0
  if (shots >= rule.fullAt) return 1
  return shots / (shots + rule.priorShots)
}

export const blendValue = (
  prior: number,
  observed: number | null | undefined,
  shots: number,
  rule: BlendRule,
): number => {
  if (observed == null || !Number.isFinite(observed)) return prior
  const w = rangeWeight(shots, rule)
  return w * observed + (1 - w) * prior
}

/** What a recommendation's club numbers rested on when it was made. */
export type ModelBasis = 'starting-bag' | 'learning' | 'measured'

export const modelBasisFromCarryWeight = (carryWeight: number | null | undefined): ModelBasis =>
  carryWeight == null ? 'measured' : carryWeight <= 0 ? 'starting-bag' : carryWeight < 1 ? 'learning' : 'measured'

export type ClubModelLabel =
  | { kind: 'starting-bag' }
  | { kind: 'learning'; shots: number; fullAt: number }
  | { kind: 'measured' }

/** How to describe a club's numbers to the player, following the carry's blend. */
export const clubModelLabel = (shots: number, hasPrior: boolean): ClubModelLabel => {
  if (!hasPrior) return { kind: 'measured' }
  if (shots <= 0) return { kind: 'starting-bag' }
  if (shots >= BLEND_RULES.carry.fullAt) return { kind: 'measured' }
  return { kind: 'learning', shots, fullAt: BLEND_RULES.carry.fullAt }
}

export const describeClubModelLabel = (label: ClubModelLabel): string | null => {
  switch (label.kind) {
    case 'starting-bag': return 'starting bag'
    case 'learning': return `learning · ${label.shots} of ${label.fullAt} shots`
    case 'measured': return null
  }
}

// ---------------------------------------------------------------- gapping

/**
 * A standard bag at driver = 1.0: each club's carry as a fraction of the
 * driver's, from launch-monitor averages of mid-handicap men. Only the *shape*
 * of this ladder is used; the three anchors stretch it to the player.
 */
const NOMINAL_FRACTION: Record<Club, number> = {
  Driver: 1.0, 'Mini Driver': 0.95, '2W': 0.94, '3W': 0.92, '4W': 0.89, '5W': 0.86, '7W': 0.82, '9W': 0.78,
  '2H': 0.86, '3H': 0.82, '4H': 0.78, '5H': 0.74, '6H': 0.70, '7H': 0.66,
  '1i': 0.87, '2i': 0.84, '3i': 0.80, '4i': 0.76, '5i': 0.72, '6i': 0.68, '7i': 0.64, '8i': 0.60, '9i': 0.56,
  PW: 0.512, AW: 0.465, GW: 0.435, SW: 0.395, LW: 0.345,
}

/** Standard launch at the nominal carry (driver = 250 yd bag), per club. */
type LaunchRow = Readonly<{ carry: number; ballSpeed: number; vla: number; spin: number; peak: number; descent: number }>
const LAUNCH_TABLE: Record<Club, LaunchRow> = {
  Driver: { carry: 250, ballSpeed: 155, vla: 11.5, spin: 2800, peak: 32, descent: 38 },
  'Mini Driver': { carry: 238, ballSpeed: 150, vla: 11.5, spin: 3100, peak: 31, descent: 39 },
  '2W': { carry: 235, ballSpeed: 148, vla: 10.5, spin: 3200, peak: 29, descent: 40 },
  '3W': { carry: 230, ballSpeed: 145, vla: 10.5, spin: 3500, peak: 29, descent: 41 },
  '4W': { carry: 222, ballSpeed: 141, vla: 11.5, spin: 3800, peak: 29, descent: 42 },
  '5W': { carry: 215, ballSpeed: 138, vla: 12.5, spin: 4200, peak: 30, descent: 44 },
  '7W': { carry: 205, ballSpeed: 134, vla: 13.5, spin: 4600, peak: 30, descent: 45 },
  '9W': { carry: 195, ballSpeed: 130, vla: 14.5, spin: 5000, peak: 30, descent: 46 },
  '2H': { carry: 215, ballSpeed: 139, vla: 11.5, spin: 4000, peak: 28, descent: 43 },
  '3H': { carry: 205, ballSpeed: 135, vla: 12.5, spin: 4400, peak: 28, descent: 44 },
  '4H': { carry: 195, ballSpeed: 131, vla: 13.5, spin: 4800, peak: 29, descent: 45 },
  '5H': { carry: 185, ballSpeed: 127, vla: 14.5, spin: 5200, peak: 29, descent: 46 },
  '6H': { carry: 175, ballSpeed: 123, vla: 15.5, spin: 5600, peak: 29, descent: 47 },
  '7H': { carry: 165, ballSpeed: 119, vla: 16.5, spin: 6000, peak: 29, descent: 48 },
  '1i': { carry: 218, ballSpeed: 140, vla: 10.5, spin: 3900, peak: 26, descent: 41 },
  '2i': { carry: 210, ballSpeed: 137, vla: 11.5, spin: 4300, peak: 27, descent: 43 },
  '3i': { carry: 200, ballSpeed: 133, vla: 12.5, spin: 4700, peak: 27, descent: 44 },
  '4i': { carry: 190, ballSpeed: 129, vla: 13.5, spin: 5100, peak: 28, descent: 45 },
  '5i': { carry: 180, ballSpeed: 125, vla: 14.5, spin: 5500, peak: 28, descent: 46 },
  '6i': { carry: 170, ballSpeed: 121, vla: 15.5, spin: 6000, peak: 28, descent: 47 },
  '7i': { carry: 160, ballSpeed: 117, vla: 17.0, spin: 6600, peak: 28, descent: 48 },
  '8i': { carry: 150, ballSpeed: 112, vla: 18.5, spin: 7300, peak: 27, descent: 49 },
  '9i': { carry: 140, ballSpeed: 107, vla: 20.5, spin: 8000, peak: 27, descent: 50 },
  PW: { carry: 128, ballSpeed: 101, vla: 23.0, spin: 8800, peak: 26, descent: 51 },
  AW: { carry: 116, ballSpeed: 95, vla: 25.0, spin: 9400, peak: 25, descent: 52 },
  GW: { carry: 109, ballSpeed: 92, vla: 26.0, spin: 9800, peak: 25, descent: 52 },
  SW: { carry: 99, ballSpeed: 86, vla: 28.0, spin: 10200, peak: 24, descent: 53 },
  LW: { carry: 86, ballSpeed: 79, vla: 31.0, spin: 10600, peak: 23, descent: 54 },
}

/** Rollout as a share of carry at the standard carry; longer and lower runs more. */
const ROLLOUT_FRACTION: Record<Club, number> = {
  Driver: 0.10, 'Mini Driver': 0.09, '2W': 0.085, '3W': 0.08, '4W': 0.075, '5W': 0.07, '7W': 0.065, '9W': 0.06,
  '2H': 0.075, '3H': 0.07, '4H': 0.065, '5H': 0.06, '6H': 0.055, '7H': 0.05,
  '1i': 0.085, '2i': 0.08, '3i': 0.07, '4i': 0.065, '5i': 0.06, '6i': 0.05, '7i': 0.045, '8i': 0.04, '9i': 0.035,
  PW: 0.03, AW: 0.025, GW: 0.02, SW: 0.02, LW: 0.015,
}

/** Longer clubs spray and bias more, per yard of carry. */
const LENGTH_FACTOR: Record<Club, number> = {
  Driver: 1.6, 'Mini Driver': 1.5, '2W': 1.45, '3W': 1.4, '4W': 1.35, '5W': 1.3, '7W': 1.25, '9W': 1.2,
  '2H': 1.3, '3H': 1.25, '4H': 1.2, '5H': 1.15, '6H': 1.1, '7H': 1.05,
  '1i': 1.3, '2i': 1.25, '3i': 1.2, '4i': 1.15, '5i': 1.1, '6i': 1.05, '7i': 1.0, '8i': 0.95, '9i': 0.9,
  PW: 0.85, AW: 0.85, GW: 0.85, SW: 0.85, LW: 0.85,
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Stretch the nominal ladder through the three anchors: a monotone piecewise
 * linear map from nominal fraction to the player's carry, pinned at PW, 7i and
 * Driver. Below PW the PW scale carries on; nothing sits above the Driver.
 */
export const gapCarries = (
  anchors: QuickBagInput['anchors'],
  clubs: readonly Club[],
  overrides: QuickBagInput['carryOverrides'] = {},
): Map<Club, number> => {
  const pins: Array<[number, number]> = ANCHOR_CLUBS
    .map((club): [number, number] => [NOMINAL_FRACTION[club], anchors[club].carryYds])
    .sort((a, b) => a[0] - b[0])
  const carryFor = (fraction: number): number => {
    const [f0, c0] = pins[0]
    if (fraction <= f0) return c0 * (fraction / f0)
    for (let i = 1; i < pins.length; i += 1) {
      const [fa, ca] = pins[i - 1]
      const [fb, cb] = pins[i]
      if (fraction <= fb) return ca + (cb - ca) * ((fraction - fa) / (fb - fa))
    }
    const [fl, cl] = pins[pins.length - 1]
    return cl * (fraction / fl)
  }
  const ordered = sortClubIds([...clubs])
  const out = new Map<Club, number>()
  // Keep the bag strictly decreasing with at least 4 yd between neighbours.
  let previous = Number.POSITIVE_INFINITY
  for (const club of ordered) {
    let carry = Math.round(carryFor(NOMINAL_FRACTION[club]))
    if (ANCHOR_CLUBS.includes(club as AnchorClub)) carry = Math.round(anchors[club as AnchorClub].carryYds)
    const typed = overrides?.[club]
    const fixed = typed != null && Number.isFinite(typed) && typed >= 20 && typed <= 350
    if (fixed) carry = Math.round(typed)
    // A typed carry is the player's word; only the guessed clubs get pushed into order.
    else if (carry > previous - 4) carry = previous - 4
    out.set(club, Math.max(20, carry))
    previous = out.get(club) as number
  }
  return out
}

// ---------------------------------------------------------------- priors by handicap

/** Lateral σ as a share of carry for a 7-iron: scratch 4%, 10 hcp 5.7%, 20 hcp 7.4%. */
const lateralSigmaFraction = (handicap: number) => 0.04 + 0.0017 * handicap
/** Carry σ as a share of carry: scratch 3.3%, 20 hcp 5.9%. */
const carrySigmaFraction = (handicap: number) => 0.033 + 0.0013 * handicap
/** A draw or fade, as a share of carry: scratch 2.5%, 15 hcp 4.3% (×1.6 for a driver). */
const shapeBiasFraction = (handicap: number) => 0.025 + 0.0012 * handicap
/** Share of swings that come up well short: scratch 6%, 10 hcp 13.5%, 20 hcp 21%. */
const mishitRate = (handicap: number) => clamp(0.06 + 0.0075 * handicap, 0.04, 0.35)

const shapeSign = (shape: ShotShape, handed: 'right' | 'left'): number => {
  const rightHanded = handed !== 'left'
  if (shape === 'neutral') return 0
  // Right-hander's draw finishes left (negative offline); fade/slice right.
  return (shape === 'draw' ? -1 : 1) * (rightHanded ? 1 : -1)
}

/**
 * Each non-anchor club takes the shape of the nearest anchor by nominal
 * length: woods and hybrids follow the Driver, mid irons the 7i, short irons
 * and wedges the PW (many players slice a driver and hit irons straight).
 */
const anchorForShape = (club: Club): AnchorClub => {
  const f = NOMINAL_FRACTION[club]
  if (f >= 0.78) return 'Driver'
  if (f >= 0.58) return '7i'
  return 'PW'
}

const scaledLaunch = (club: Club, carryYds: number): QuickBagClubPrior['launch'] => {
  const row = LAUNCH_TABLE[club]
  const ratio = carryYds / row.carry
  return {
    // Carry goes roughly as ball speed^1.3 over the range that matters.
    ballSpeedMph: Math.round(row.ballSpeed * ratio ** (1 / 1.3) * 10) / 10,
    vlaDeg: row.vla,
    // Slower swings spin a little more for the same loft; faster a little less.
    totalSpinRpm: Math.round(row.spin * ratio ** -0.2 / 50) * 50,
    peakHeightYds: Math.round(row.peak * ratio * 10) / 10,
    descentAngleDeg: row.descent,
  }
}

/** Plus handicaps (better than scratch) are negative here: +2 is −2, and tighter than scratch. */
export const MIN_HANDICAP = -10
export const MAX_HANDICAP = 36

export const normalizeHandicap = (handicap: number | null | undefined): number =>
  handicap == null || !Number.isFinite(handicap)
    ? DEFAULT_HANDICAP
    : clamp(Math.round(handicap * 10) / 10, MIN_HANDICAP, MAX_HANDICAP)

export const buildQuickBagPrior = (input: QuickBagInput): QuickBagPrior => {
  const handicap = normalizeHandicap(input.handicap)
  const carries = gapCarries(input.anchors, input.clubs, input.carryOverrides)
  const clubs = sortClubIds([...input.clubs]).map((club): QuickBagClubPrior => {
    const carryYds = carries.get(club) as number
    const length = LENGTH_FACTOR[club]
    const anchor = anchorForShape(club)
    const bias = shapeSign(input.anchors[anchor].shape, input.handed) * shapeBiasFraction(handicap) * carryYds * length
    const carrySigma = carrySigmaFraction(handicap) * carryYds * (0.9 + 0.2 * (length - 0.85) / 0.75)
    const rollout = ROLLOUT_FRACTION[club] * carryYds
    return {
      club,
      carryYds,
      totalYds: Math.round(carryYds + rollout),
      carrySigmaYds: Math.round(carrySigma * 10) / 10,
      totalSigmaYds: Math.round(carrySigma * 1.15 * 10) / 10,
      lateralBiasYds: Math.round(bias * 10) / 10,
      lateralSigmaYds: Math.round(lateralSigmaFraction(handicap) * carryYds * length * 10) / 10,
      mishitRate: Math.round(mishitRate(handicap) * 1000) / 1000,
      severeShare: 0.25,
      launch: scaledLaunch(club, carryYds),
    }
  })
  return { input, handicap, clubs }
}

// ---------------------------------------------------------------- validation

export const QUICK_BAG_CARRY_LIMITS: Record<AnchorClub, readonly [number, number]> = {
  Driver: [120, 340],
  '7i': [70, 220],
  PW: [40, 170],
}

/** Why a set of anchors can't be used, or null when it can. */
export const quickBagInputProblem = (anchors: Partial<Record<AnchorClub, Partial<QuickBagAnchor>>>): string | null => {
  for (const club of ANCHOR_CLUBS) {
    const carry = anchors[club]?.carryYds
    const [lo, hi] = QUICK_BAG_CARRY_LIMITS[club]
    if (carry == null || !Number.isFinite(carry)) return `Enter a ${club === 'Driver' ? 'driver' : club} carry.`
    if (carry < lo || carry > hi) return `A ${club === 'Driver' ? 'driver' : club} carry of ${Math.round(carry)} yd is outside ${lo}–${hi}.`
  }
  const d = anchors.Driver!.carryYds as number
  const i7 = anchors['7i']!.carryYds as number
  const pw = anchors.PW!.carryYds as number
  if (!(d > i7 + 15)) return 'The driver should carry at least 15 yd past the 7-iron.'
  if (!(i7 > pw + 10)) return 'The 7-iron should carry at least 10 yd past the PW.'
  return null
}
