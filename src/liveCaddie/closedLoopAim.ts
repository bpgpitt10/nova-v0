export type AimPixelPoint = {
  x: number
  y: number
}

export type AimSteerDirection = 'left' | 'right'

export type AimCorrectionPlan =
  | {
      status: 'aligned'
      errorDeg: number
      pulses: 0
      direction: null
    }
  | {
      status: 'steer'
      errorDeg: number
      pulses: number
      direction: AimSteerDirection
    }

export type AimLoopObservation = {
  ballPixel: AimPixelPoint
  markerPixel: AimPixelPoint
  observedAt?: number
}

export type AimLoopResult =
  | {
      status: 'aligned'
      iterations: number
      finalErrorDeg: number
      observation: AimLoopObservation
    }
  | {
      status: 'stalled' | 'max-iterations'
      iterations: number
      finalErrorDeg: number
      observation: AimLoopObservation
    }

export type AimLoopOptions = {
  toleranceDeg?: number
  pulseDegrees?: number
  maxPulsesPerIteration?: number
  maxIterations?: number
  settleMs?: number
  minimumObservedMovementDeg?: number
  maxConsecutiveStalls?: number
}

const toDegrees = (radians: number) => (radians * 180) / Math.PI

const normalizeSignedDegrees = (degrees: number) => {
  let normalized = ((degrees + 180) % 360 + 360) % 360 - 180
  if (normalized === -180) normalized = 180
  return normalized
}

/**
 * Screen-space bearing around the ball. Zero points straight up the minimap,
 * positive angles point right, and negative angles point left.
 */
export const aimPixelBearingDegrees = (
  ballPixel: AimPixelPoint,
  pointPixel: AimPixelPoint,
) => {
  const dx = pointPixel.x - ballPixel.x
  const dy = pointPixel.y - ballPixel.y
  if (Math.hypot(dx, dy) < 1e-6) {
    throw new Error('Aim marker is indistinguishable from the ball pixel.')
  }
  return toDegrees(Math.atan2(dx, -dy))
}

export const aimPixelAngularErrorDegrees = (
  ballPixel: AimPixelPoint,
  markerPixel: AimPixelPoint,
  desiredPixel: AimPixelPoint,
) => normalizeSignedDegrees(
  aimPixelBearingDegrees(ballPixel, desiredPixel)
    - aimPixelBearingDegrees(ballPixel, markerPixel),
)

export const planPixelAimCorrection = ({
  ballPixel,
  markerPixel,
  desiredPixel,
  toleranceDeg = 0.12,
  pulseDegrees = 0.3,
  maxPulsesPerIteration = 8,
}: {
  ballPixel: AimPixelPoint
  markerPixel: AimPixelPoint
  desiredPixel: AimPixelPoint
  toleranceDeg?: number
  pulseDegrees?: number
  maxPulsesPerIteration?: number
}): AimCorrectionPlan => {
  if (toleranceDeg <= 0 || pulseDegrees <= 0 || maxPulsesPerIteration < 1) {
    throw new Error('Aim correction tuning values must be positive.')
  }

  const errorDeg = aimPixelAngularErrorDegrees(ballPixel, markerPixel, desiredPixel)
  if (Math.abs(errorDeg) <= toleranceDeg) {
    return { status: 'aligned', errorDeg, pulses: 0, direction: null }
  }

  // Never deliberately overshoot by more than half a pulse when close to target.
  const estimatedPulses = Math.max(1, Math.round(Math.abs(errorDeg) / pulseDegrees))
  const pulses = Math.min(maxPulsesPerIteration, estimatedPulses)

  return {
    status: 'steer',
    errorDeg,
    pulses,
    direction: errorDeg < 0 ? 'left' : 'right',
  }
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

/**
 * Actuator-agnostic closed loop. The observer is the source of truth: after
 * every steering burst we re-read the marker and correct from its actual pixel.
 */
export const runPixelAimClosedLoop = async ({
  desiredPixel,
  observe,
  actuate,
  options = {},
}: {
  desiredPixel: AimPixelPoint
  observe: () => Promise<AimLoopObservation>
  actuate: (direction: AimSteerDirection, pulses: number) => Promise<void>
  options?: AimLoopOptions
}): Promise<AimLoopResult> => {
  const toleranceDeg = options.toleranceDeg ?? 0.12
  const pulseDegrees = options.pulseDegrees ?? 0.3
  const maxPulsesPerIteration = options.maxPulsesPerIteration ?? 8
  const maxIterations = options.maxIterations ?? 12
  const settleMs = options.settleMs ?? 90
  const minimumObservedMovementDeg = options.minimumObservedMovementDeg ?? 0.04
  const maxConsecutiveStalls = options.maxConsecutiveStalls ?? 2

  let observation = await observe()
  let previousBearing = aimPixelBearingDegrees(observation.ballPixel, observation.markerPixel)
  let consecutiveStalls = 0

  for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
    const plan = planPixelAimCorrection({
      ballPixel: observation.ballPixel,
      markerPixel: observation.markerPixel,
      desiredPixel,
      toleranceDeg,
      pulseDegrees,
      maxPulsesPerIteration,
    })

    if (plan.status === 'aligned') {
      return {
        status: 'aligned',
        iterations: iteration,
        finalErrorDeg: plan.errorDeg,
        observation,
      }
    }

    if (iteration === maxIterations) {
      return {
        status: 'max-iterations',
        iterations: iteration,
        finalErrorDeg: plan.errorDeg,
        observation,
      }
    }

    await actuate(plan.direction, plan.pulses)
    if (settleMs > 0) await sleep(settleMs)

    observation = await observe()
    const currentBearing = aimPixelBearingDegrees(observation.ballPixel, observation.markerPixel)
    const movementDeg = Math.abs(normalizeSignedDegrees(currentBearing - previousBearing))
    previousBearing = currentBearing

    if (movementDeg < minimumObservedMovementDeg) {
      consecutiveStalls += 1
      if (consecutiveStalls >= maxConsecutiveStalls) {
        return {
          status: 'stalled',
          iterations: iteration + 1,
          finalErrorDeg: aimPixelAngularErrorDegrees(
            observation.ballPixel,
            observation.markerPixel,
            desiredPixel,
          ),
          observation,
        }
      }
    } else {
      consecutiveStalls = 0
    }
  }

  throw new Error('Closed-loop aim exited unexpectedly.')
}
