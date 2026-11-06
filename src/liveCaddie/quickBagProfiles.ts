import type { Club } from '../lib/bagConfig'
import {
  BLEND_RULES,
  blendValue,
  rangeWeight,
  type QuickBagClubPrior,
  type QuickBagPrior,
} from '../lib/quickBag'
import type { DecisionPlayerClubModel, DecisionPlayerSample } from './decisionEngine'
import type { LiveCaddieClubProfile, LiveCaddieProfileSet } from './types'

/**
 * Lays the Quick Bag prior under the player's range data for the engine.
 *
 * The profile set (means, sigmas, launch) and the decision player models (the
 * weighted shot population the mishit tail is learned from) are both built
 * from range sessions only. For each club in the Quick Bag this module blends
 * the prior in by shot count (see BLEND_RULES) and, for clubs with no or few
 * shots, supplies a synthetic population so the risk model has a tail to
 * replay. A club with enough shots is untouched.
 */

/** The prior counts as this many shots for the engine's comparison floor and confidence. */
export const PRIOR_SUPPORT_SHOTS = 4

export type StartingBagMark = Readonly<{
  /** Included Stock range shots for the club. */
  shots: number
  /** Weight on the range data for the carry (0 = all prior, 1 = all range). */
  carryWeight: number
}>

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const priorProfile = (prior: QuickBagClubPrior): LiveCaddieClubProfile => ({
  club: prior.club,
  stock_carry_yds: prior.carryYds,
  stock_total_yds: prior.totalYds,
  carry_sigma_yds: prior.carrySigmaYds,
  total_sigma_yds: prior.totalSigmaYds,
  lateral_bias_yds: prior.lateralBiasYds,
  lateral_sigma_yds: prior.lateralSigmaYds,
  launch_profile: {
    ball_speed_mph: prior.launch.ballSpeedMph,
    vla_deg: prior.launch.vlaDeg,
    hla_deg: 0,
    total_spin_rpm: prior.launch.totalSpinRpm,
    spin_axis_deg: 0,
    peak_height_yds: prior.launch.peakHeightYds,
    descent_angle_deg: prior.launch.descentAngleDeg,
  },
})

const blendProfile = (
  measured: LiveCaddieClubProfile,
  prior: QuickBagClubPrior,
  shots: number,
): LiveCaddieClubProfile => {
  const carry = blendValue(prior.carryYds, measured.stock_carry_yds, shots, BLEND_RULES.carry)
  const rollout = finite(measured.stock_total_yds)
    ? measured.stock_total_yds - measured.stock_carry_yds
    : null
  const total = blendValue(prior.totalYds - prior.carryYds, rollout, shots, BLEND_RULES.carry) + carry
  const launch = measured.launch_profile ?? {}
  const pick = (observed: number | undefined, fallback: number) =>
    blendValue(fallback, observed, shots, BLEND_RULES.sigma)
  return {
    ...measured,
    stock_carry_yds: carry,
    stock_total_yds: total,
    carry_sigma_yds: blendValue(prior.carrySigmaYds, measured.carry_sigma_yds, shots, BLEND_RULES.sigma),
    total_sigma_yds: blendValue(prior.totalSigmaYds, measured.total_sigma_yds, shots, BLEND_RULES.sigma),
    lateral_bias_yds: blendValue(prior.lateralBiasYds, measured.lateral_bias_yds, shots, BLEND_RULES.lateralBias),
    lateral_sigma_yds: blendValue(prior.lateralSigmaYds, measured.lateral_sigma_yds, shots, BLEND_RULES.sigma),
    launch_profile: {
      ...launch,
      ball_speed_mph: pick(launch.ball_speed_mph, prior.launch.ballSpeedMph),
      vla_deg: pick(launch.vla_deg, prior.launch.vlaDeg),
      total_spin_rpm: pick(launch.total_spin_rpm, prior.launch.totalSpinRpm),
      peak_height_yds: pick(launch.peak_height_yds, prior.launch.peakHeightYds),
      descent_angle_deg: pick(launch.descent_angle_deg, prior.launch.descentAngleDeg),
    },
  }
}

export type QuickBagProfileSet = LiveCaddieProfileSet & {
  starting_bag: Readonly<Record<string, StartingBagMark>>
}

/**
 * Profile set with the Quick Bag underneath: clubs with no range data get the
 * prior; clubs with some get a blend; clubs past the carry handover keep their
 * measured numbers but still blend sigmas until theirs are trusted.
 */
export const applyQuickBagToProfileSet = (
  profileSet: LiveCaddieProfileSet,
  prior: QuickBagPrior | null | undefined,
): QuickBagProfileSet => {
  const marks: Record<string, StartingBagMark> = {}
  if (!prior) return { ...profileSet, starting_bag: marks }
  const clubs: LiveCaddieClubProfile[] = profileSet.clubs.map((profile) => ({ ...profile }))
  const support = profileSet.club_support.map((item) => ({ ...item }))
  for (const clubPrior of prior.clubs) {
    const index = clubs.findIndex((profile) => profile.club === clubPrior.club)
    const supportIndex = support.findIndex((item) => item.club === clubPrior.club)
    const shots = supportIndex >= 0 ? support[supportIndex].included_stock_shots : 0
    if (shots >= BLEND_RULES.mishit.fullAt) continue
    marks[clubPrior.club] = { shots, carryWeight: rangeWeight(shots, BLEND_RULES.carry) }
    if (index >= 0) {
      clubs[index] = blendProfile(clubs[index], clubPrior, shots)
    } else {
      clubs.push(priorProfile(clubPrior))
    }
    // While the prior still carries weight it also stands in for shots: the
    // engine's comparison floor and confidence treat it as a few range balls,
    // so a brand-new bag ranks its clubs against each other instead of
    // sending every one of them to the cold-start bench.
    const phantom = shots < BLEND_RULES.sigma.fullAt ? PRIOR_SUPPORT_SHOTS : 0
    if (supportIndex >= 0) {
      support[supportIndex] = {
        ...support[supportIndex],
        included_stock_shots: shots + phantom,
        sessions: Math.max(1, support[supportIndex].sessions),
      }
    } else {
      support.push({ club: clubPrior.club, included_stock_shots: phantom, sessions: 1, pure_tagged_shots: 0 })
    }
  }
  return { ...profileSet, clubs, club_support: support, starting_bag: marks }
}

// ---------------------------------------------------------------- decision players

/** Deterministic standard-normal quantiles, symmetric, for a small synthetic cloud. */
const normalQuantiles = (count: number): number[] => {
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const p = (i + 0.5) / count
    out.push(inverseNormal(p))
  }
  return out
}

// Acklam's rational approximation of the inverse normal CDF.
const inverseNormal = (p: number): number => {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= 1 - pl) {
    const q = p - 0.5
    const r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

const CORE_SAMPLES = 24
const TAIL_SAMPLES = 6

/**
 * A synthetic shot population for the prior: a Gaussian core and a mishit
 * tail (short, and wider) at the handicap's rate. Weighted so the prior's
 * share against the real shots follows BLEND_RULES.mishit.
 */
export const syntheticPriorSamples = (
  prior: QuickBagClubPrior,
  realShots: number,
  realWeight: number,
  nowIso: string,
): DecisionPlayerSample[] => {
  const w = rangeWeight(realShots, BLEND_RULES.mishit)
  if (w >= 1) return []
  // Prior weight so that prior / (prior + real) = 1 − w. With no real shots, 1.
  const priorWeight = realShots > 0 && realWeight > 0 ? realWeight * (1 - w) / w : 1
  const coreShare = 1 - prior.mishitRate
  const samples: DecisionPlayerSample[] = []
  const zs = normalQuantiles(CORE_SAMPLES)
  // Pair carry and lateral quantiles out of phase so the cloud is 2-D, not a line.
  zs.forEach((zCarry, i) => {
    const zLat = zs[(i * 7 + 3) % CORE_SAMPLES]
    samples.push({
      shotId: `quick-bag:${prior.club}:core:${i}`,
      capturedAt: nowIso,
      carryYds: Math.max(5, prior.carryYds + zCarry * prior.carrySigmaYds),
      totalYds: Math.max(5, prior.totalYds + zCarry * prior.totalSigmaYds),
      offlineYds: prior.lateralBiasYds + zLat * prior.lateralSigmaYds,
      weight: priorWeight * coreShare / CORE_SAMPLES,
      quality: 'normal',
      planningEligible: true,
      classificationConfidence: null,
    })
  })
  const tailZ = normalQuantiles(TAIL_SAMPLES)
  tailZ.forEach((z, i) => {
    const severe = i < Math.round(TAIL_SAMPLES * prior.severeShare)
    const loss = severe ? 0.25 : 0.12
    const share = severe ? prior.mishitRate * prior.severeShare : prior.mishitRate * (1 - prior.severeShare)
    const count = severe ? Math.max(1, Math.round(TAIL_SAMPLES * prior.severeShare)) : TAIL_SAMPLES - Math.round(TAIL_SAMPLES * prior.severeShare)
    samples.push({
      shotId: `quick-bag:${prior.club}:tail:${i}`,
      capturedAt: nowIso,
      carryYds: Math.max(5, prior.carryYds * (1 - loss)),
      totalYds: Math.max(5, prior.totalYds * (1 - loss)),
      offlineYds: prior.lateralBiasYds * 1.5 + z * prior.lateralSigmaYds * 1.8,
      weight: priorWeight * share / count,
      quality: severe ? 'severe_mishit' : 'mishit',
      planningEligible: false,
      classificationConfidence: null,
    })
  })
  return samples
}

/**
 * Decision player models with the Quick Bag underneath: each club in the bag
 * has a population to replay, its numbers follow the blended profile, and the
 * prior's synthetic shots fade out by BLEND_RULES.mishit.
 */
export const applyQuickBagToPlayers = (
  players: readonly DecisionPlayerClubModel[],
  profileSet: QuickBagProfileSet,
  prior: QuickBagPrior | null | undefined,
  nowMs: number,
): DecisionPlayerClubModel[] => {
  if (!prior) return [...players]
  const nowIso = new Date(nowMs).toISOString()
  const out: DecisionPlayerClubModel[] = players.map((player) => ({ ...player }))
  for (const clubPrior of prior.clubs) {
    const mark = profileSet.starting_bag[clubPrior.club]
    if (!mark) continue
    const profile = profileSet.clubs.find((p) => p.club === clubPrior.club)
    const support = profileSet.club_support.find((s) => s.club === clubPrior.club)
    const index = out.findIndex((player) => player.club === clubPrior.club)
    const existing = index >= 0 ? out[index] : null
    const realWeight = existing ? existing.samples.reduce((sum, s) => sum + Math.max(0, s.weight), 0) : 0
    const synthetic = syntheticPriorSamples(clubPrior, mark.shots, realWeight, nowIso)
    const model: DecisionPlayerClubModel = {
      club: clubPrior.club,
      variantId: existing?.variantId ?? 'stock',
      variantLabel: existing?.variantLabel ?? 'Stock',
      stockCarryYds: profile?.stock_carry_yds ?? clubPrior.carryYds,
      carrySigmaYds: profile?.carry_sigma_yds ?? clubPrior.carrySigmaYds,
      lateralBiasYds: profile?.lateral_bias_yds ?? clubPrior.lateralBiasYds,
      lateralSigmaYds: profile?.lateral_sigma_yds ?? clubPrior.lateralSigmaYds,
      supportShots: support?.included_stock_shots ?? mark.shots,
      supportingSessions: support?.sessions ?? 1,
      samples: [...(existing?.samples ?? []), ...synthetic],
      representativeLaunch: existing?.representativeLaunch ?? {
        ballSpeedMph: profile?.launch_profile?.ball_speed_mph ?? null,
        vlaDeg: profile?.launch_profile?.vla_deg ?? null,
        hlaDeg: 0,
        totalSpinRpm: profile?.launch_profile?.total_spin_rpm ?? null,
        spinAxisDeg: 0,
        peakHeightYds: profile?.launch_profile?.peak_height_yds ?? null,
        descentAngleDeg: profile?.launch_profile?.descent_angle_deg ?? null,
      },
      representativeClub: existing?.representativeClub ?? { clubPathDeg: null, angleOfAttackDeg: null },
    }
    if (index >= 0) out[index] = model
    else out.push(model)
  }
  return out
}

export const startingBagClubs = (prior: QuickBagPrior | null | undefined): Club[] =>
  prior ? prior.clubs.map((c) => c.club) : []
