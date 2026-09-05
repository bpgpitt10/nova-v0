import type {
  BaselineStatus,
  MishitBaseline,
  MishitConfig,
  MishitShot,
  RobustMetricBaseline,
} from './types'
import { finiteNumbers, median, medianAbsoluteDeviation } from './stats'

const timestampMs = (value: string | undefined) => {
  if (!value) {
    return undefined
  }
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : undefined
}

export const selectReferenceShots = (
  shots: MishitShot[],
  maxReferenceShots: number,
) => {
  const indexed = shots.map((shot, index) => ({ shot, index, time: timestampMs(shot.capturedAt) }))
  const sorted = [...indexed].sort((left, right) => {
    if (typeof left.time === 'number' && typeof right.time === 'number') {
      return left.time - right.time
    }
    if (typeof left.time === 'number') {
      return 1
    }
    if (typeof right.time === 'number') {
      return -1
    }
    return left.index - right.index
  })

  return sorted
    .slice(Math.max(0, sorted.length - Math.max(1, maxReferenceShots)))
    .map((entry) => entry.shot)
}

const buildMetricBaseline = (
  values: Array<number | undefined>,
): RobustMetricBaseline => {
  const finite = finiteNumbers(values)
  const center = median(finite)
  return {
    center,
    mad: medianAbsoluteDeviation(finite, center),
    sampleSize: finite.length,
  }
}

export const baselineStatusForSampleSize = (
  sampleSize: number,
  config: MishitConfig,
): BaselineStatus => {
  if (sampleSize < config.sample.provisionalSampleSize) {
    return 'insufficient'
  }
  if (sampleSize < config.sample.stableSampleSize) {
    return 'provisional'
  }
  return 'stable'
}

export const buildMishitBaseline = (
  shots: MishitShot[],
  config: MishitConfig,
  version = 1,
): MishitBaseline => {
  const referenceShots = selectReferenceShots(shots, config.sample.maxReferenceShots)
  const sampleSize = referenceShots.length

  return {
    version,
    status: baselineStatusForSampleSize(sampleSize, config),
    sampleSize,
    referenceShotCount: referenceShots.length,
    carry: buildMetricBaseline(referenceShots.map((shot) => shot.carry)),
    offline: buildMetricBaseline(referenceShots.map((shot) => shot.offline)),
    ballSpeed: buildMetricBaseline(referenceShots.map((shot) => shot.ballSpeed)),
    smashFactor: buildMetricBaseline(referenceShots.map((shot) => shot.smashFactor)),
  }
}
