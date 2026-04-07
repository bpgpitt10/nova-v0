import type {
  IncomingNovaShot,
  OpenGolfCoachDerivedValues,
  OpenGolfCoachInput,
  OpenGolfCoachPayload,
} from '../types'

export type OpenGolfCoachEnrichmentResult = {
  derivedValues: OpenGolfCoachDerivedValues
  payload: OpenGolfCoachPayload | null
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
        payload: null,
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
          payload: null,
          status: 'failure',
        }
      }

      const payload: unknown = await response.json()
      console.info('[OpenGolfCoach] parsed response:', payload)

      if (!payload || typeof payload !== 'object') {
        console.info('[OpenGolfCoach] enrichment skipped: helper request failed')
        return {
          derivedValues: {},
          payload: null,
          status: 'failure',
        }
      }

      return {
        derivedValues: extractOpenGolfCoachDerivedValues(payload as OpenGolfCoachPayload),
        payload: payload as OpenGolfCoachPayload,
        status: 'success',
      }
    } catch (error) {
      console.info('[OpenGolfCoach] enrichment skipped: helper request failed')
      console.info('[OpenGolfCoach] fetch error:', error)
      return {
        derivedValues: {},
        payload: null,
        status: 'failure',
      }
    }
  },
}

export const extractOpenGolfCoachDerivedValues = (
  payload: OpenGolfCoachPayload,
): OpenGolfCoachDerivedValues => {
  const coach =
    payload.open_golf_coach &&
    typeof payload.open_golf_coach === 'object' &&
    !Array.isArray(payload.open_golf_coach)
      ? (payload.open_golf_coach as Record<string, unknown>)
      : {}
  const customary =
    coach.us_customary_units &&
    typeof coach.us_customary_units === 'object' &&
    !Array.isArray(coach.us_customary_units)
      ? (coach.us_customary_units as Record<string, unknown>)
      : {}

  return {
    carry_distance_yards:
      typeof customary.carry_distance_yards === 'number'
        ? customary.carry_distance_yards
        : undefined,
    total_distance_yards:
      typeof customary.total_distance_yards === 'number'
        ? customary.total_distance_yards
        : undefined,
    offline_distance_yards:
      typeof customary.offline_distance_yards === 'number'
        ? customary.offline_distance_yards
        : undefined,
    shot_name: typeof coach.shot_name === 'string' ? coach.shot_name : undefined,
    shot_rank:
      typeof coach.shot_rank === 'number' || typeof coach.shot_rank === 'string'
        ? coach.shot_rank
        : undefined,
  }
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
