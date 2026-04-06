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
    console.info('[OpenGolfCoach] enrichShot called')

    if (!openGolfCoachUrl) {
      console.info('[OpenGolfCoach] enrichment skipped: helper URL missing')
      return {
        derivedValues: {},
        status: 'not_configured',
      }
    }

    console.info('[OpenGolfCoach] helper URL:', openGolfCoachUrl)
    console.info('[OpenGolfCoach] request input:', input)

    try {
      const response = await fetch(`${openGolfCoachUrl}/derive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      })

      console.info('[OpenGolfCoach] response status:', response.status)

      if (!response.ok) {
        console.info('[OpenGolfCoach] enrichment skipped: helper request failed')
        return {
          derivedValues: {},
          status: 'failure',
        }
      }

      const derivedValues: unknown = await response.json()
      console.info('[OpenGolfCoach] parsed response:', derivedValues)

      if (!derivedValues || typeof derivedValues !== 'object') {
        console.info('[OpenGolfCoach] enrichment skipped: helper request failed')
        return {
          derivedValues: {},
          status: 'failure',
        }
      }

      return {
        derivedValues: derivedValues as OpenGolfCoachDerivedValues,
        status: 'success',
      }
    } catch (error) {
      console.info('[OpenGolfCoach] enrichment skipped: helper request failed')
      console.info('[OpenGolfCoach] fetch error:', error)
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
