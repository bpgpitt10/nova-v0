import {
  MODELED_AIM_SAMPLE_COUNT,
  standardizedAimSamples,
  type ShotDraw,
} from './aimOutcomeSampling'

/**
 * The player's own shot shape as the simulated core.
 *
 * The bell curve around Stock is symmetric, so it treats "flushed it 8 yd
 * long" exactly like "caught it 8 yd thin". Real swings are lopsided: the short
 * side is wide, and the long side has a ceiling near the player's best strike.
 * Here the 2,048 core shots are drawn from the player's actual good shots
 * instead, so flushed shots appear exactly as often, and as far, as they
 * really happen. No separate "Pure" frequency is invented: Pure stays the
 * yardage-book definition (shotProfiles.ts) and is only used to explain.
 *
 * Population: the same weighted Stock shots the mishit tail is split from
 * (decisionEngine player samples), keeping only planning-eligible shots. The
 * mishits stay in the tail (decisionRiskProfile), so every shot counts once.
 *
 * Each shot is blurred into a small cloud (Gaussian kernel, half the Silverman
 * bandwidth) so 30 shots behave like a smooth shape, not 30 dots. The blur is
 * variance-corrected: the cloud has the same spread as the shots themselves.
 * Each shot keeps its own rollout (a flushed, spinning iron that stops is
 * preserved). Live conditions translate every shot by the same carry and
 * lateral deltas the bell curve uses.
 */

/** Below this many good shots for a club, the bell curve is kept. */
export const EMPIRICAL_CORE_MIN_SHOTS = 20

/** Stride used to pair each chosen shot with a blur draw (odd, so it cycles all 2,048). */
const BLUR_STRIDE = 1031

export type EmpiricalCoreShot = {
  carryYds: number
  /** Rest distance; when missing the club's Stock rollout is used. */
  totalYds?: number | null
  offlineYds: number
  weight: number
}

export type EmpiricalShotCore = {
  draws: ShotDraw[]
  shotCount: number
  /** Kish effective sample size of the weighted shots. */
  effectiveShotCount: number
  carryBlurYds: number
  offlineBlurYds: number
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const buildEmpiricalShotCore = ({
  shots,
  carryAdjustmentYds,
  lateralAdjustmentYds,
  stockRolloutYds,
  minShots = EMPIRICAL_CORE_MIN_SHOTS,
  count = MODELED_AIM_SAMPLE_COUNT,
}: {
  shots: readonly EmpiricalCoreShot[]
  /** Live-condition carry change relative to the Stock baseline. */
  carryAdjustmentYds: number
  /** Live-condition lateral change relative to the Stock lateral baseline. */
  lateralAdjustmentYds: number
  /** Club's Stock rollout, used for shots without a recorded total. */
  stockRolloutYds: number
  minShots?: number
  count?: number
}): EmpiricalShotCore | null => {
  const usable = shots.filter((shot) =>
    finite(shot.carryYds) && finite(shot.offlineYds) && finite(shot.weight) && shot.weight > 0,
  )
  if (usable.length < minShots) return null

  const weightSum = usable.reduce((sum, shot) => sum + shot.weight, 0)
  const weights = usable.map((shot) => shot.weight / weightSum)
  const effectiveShotCount = 1 / weights.reduce((sum, weight) => sum + weight * weight, 0)

  const mean = (pick: (shot: EmpiricalCoreShot) => number) =>
    usable.reduce((sum, shot, index) => sum + pick(shot) * weights[index], 0)
  const spread = (pick: (shot: EmpiricalCoreShot) => number, center: number) =>
    Math.sqrt(usable.reduce((sum, shot, index) => sum + weights[index] * (pick(shot) - center) ** 2, 0))
  const carryCenter = mean((shot) => shot.carryYds)
  const offlineCenter = mean((shot) => shot.offlineYds)
  const carrySpread = Math.max(0.5, spread((shot) => shot.carryYds, carryCenter))
  const offlineSpread = Math.max(0.5, spread((shot) => shot.offlineYds, offlineCenter))

  // Half of Silverman's rule of thumb, then shrink so blur + shots keep the shots'
  // own spread. A full Silverman blur needs more shrink, which pulls the real
  // flushed and thin shots toward the middle (at 25 shots: ~13% vs ~4% here).
  const bandwidthFactor = 0.5 * 1.06 * effectiveShotCount ** (-1 / 5)
  const shrink = 1 / Math.sqrt(1 + bandwidthFactor * bandwidthFactor)
  const carryBlurYds = bandwidthFactor * carrySpread
  const offlineBlurYds = bandwidthFactor * offlineSpread

  const normals = standardizedAimSamples()
  const draws: ShotDraw[] = []
  let shotIndex = 0
  let cumulative = weights[0]
  for (let k = 0; k < count; k += 1) {
    // Stratified pick: each shot gets draws in proportion to its weight.
    const target = (k + 0.5) / count
    while (shotIndex < usable.length - 1 && cumulative < target) {
      shotIndex += 1
      cumulative += weights[shotIndex]
    }
    const shot = usable[shotIndex]
    const { carryZ, lateralZ } = normals[(k * BLUR_STRIDE) % normals.length]
    const rolloutYds = finite(shot.totalYds)
      ? Math.max(0, shot.totalYds - shot.carryYds)
      : Math.max(0, stockRolloutYds)
    const carryYds = Math.max(
      0,
      carryCenter + (shot.carryYds - carryCenter + carryZ * carryBlurYds) * shrink + carryAdjustmentYds,
    )
    draws.push({
      carryYds,
      totalYds: carryYds + rolloutYds,
      offlineYds: offlineCenter + (shot.offlineYds - offlineCenter + lateralZ * offlineBlurYds) * shrink + lateralAdjustmentYds,
    })
  }

  return { draws, shotCount: usable.length, effectiveShotCount, carryBlurYds, offlineBlurYds }
}
