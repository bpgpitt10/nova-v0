import type {
  IncomingNovaShot,
  OpenGolfCoachDerivedValues,
  OpenGolfCoachInput,
} from '../types'

export type OpenGolfCoachEnrichmentResult = {
  derivedValues: OpenGolfCoachDerivedValues
  status: 'not_configured' | 'success' | 'failure'
}

export type OpenGolfCoachEnricher = {
  enrichShot: (
    input: OpenGolfCoachInput,
  ) => Promise<OpenGolfCoachEnrichmentResult>
}

const openGolfCoachUrl = import.meta.env.VITE_OPEN_GOLF_COACH_URL as
  | string
  | undefined

export const isOpenGolfCoachConfigured = Boolean(openGolfCoachUrl)

// Placeholder enrichment boundary.
// Nova remains the raw live-shot source.
// OpenGolfCoach is intended to consume normalized launch/spin inputs and return
// derived values like carry, total, offline, shot name, and shot rank.
export const openGolfCoachEnricher: OpenGolfCoachEnricher = {
  async enrichShot(input) {
    if (!openGolfCoachUrl) {
      return {
        derivedValues: {},
        status: 'not_configured',
      }
    }

    try {
      const response = await fetch(`${openGolfCoachUrl}/derive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      })

      if (!response.ok) {
        return {
          derivedValues: {},
          status: 'failure',
        }
      }

      const derivedValues: unknown = await response.json()
      if (!derivedValues || typeof derivedValues !== 'object') {
        return {
          derivedValues: {},
          status: 'failure',
        }
      }

      return {
        derivedValues: derivedValues as OpenGolfCoachDerivedValues,
        status: 'success',
      }
    } catch {
      return {
        derivedValues: {},
        status: 'failure',
      }
    }
  },
}

export const buildOpenGolfCoachInput = (
  shot: IncomingNovaShot,
): OpenGolfCoachInput => ({
  ball_speed_meters_per_second:
    shot.ball_speed_meters_per_second ?? shot.ballSpeedMetersPerSecond,
  vertical_launch_angle_degrees:
    shot.vertical_launch_angle_degrees ?? shot.verticalLaunchAngleDegrees,
  horizontal_launch_angle_degrees:
    shot.horizontal_launch_angle_degrees ?? shot.horizontalLaunchAngleDegrees,
  total_spin_rpm: shot.total_spin_rpm ?? shot.totalSpinRpm,
  spin_axis_degrees: shot.spin_axis_degrees ?? shot.spinAxisDegrees,
})

export const hasOpenGolfCoachInput = (input: OpenGolfCoachInput) =>
  Object.values(input).some((value) => typeof value === 'number')
