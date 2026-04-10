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

const OPEN_GOLF_COACH_LOCAL_STORAGE_KEY = 'open-golf-coach-url'
const OPEN_GOLF_COACH_DEFAULT_URL = 'http://127.0.0.1:8787'

const safeLocalStorageGet = (key: string) => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const resolveOpenGolfCoachUrl = () => {
  const envUrl = (import.meta.env.VITE_OPEN_GOLF_COACH_URL as string | undefined)?.trim()
  if (envUrl) {
    return { url: envUrl, source: 'env' as const }
  }

  const localUrl = safeLocalStorageGet(OPEN_GOLF_COACH_LOCAL_STORAGE_KEY)?.trim()
  if (localUrl) {
    return { url: localUrl, source: 'localStorage' as const }
  }

  const isDesktop = typeof window !== 'undefined' && Boolean((window as any).__TAURI__)
  if (isDesktop) {
    return { url: OPEN_GOLF_COACH_DEFAULT_URL, source: 'tauri_fallback' as const }
  }

  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
      return { url: OPEN_GOLF_COACH_DEFAULT_URL, source: 'localhost_fallback' as const }
    }
  }

  return { url: undefined, source: 'unresolved' as const }
}

export const isOpenGolfCoachConfigured = Boolean(resolveOpenGolfCoachUrl().url)

// Placeholder enrichment boundary.
// Nova remains the raw live-shot source.
// OpenGolfCoach is intended to consume normalized launch/spin inputs and return
// derived values like carry, total, offline, shot name, and shot rank.
export const openGolfCoachEnricher: OpenGolfCoachEnricher = {
  async enrichShot(input) {
    const resolved = resolveOpenGolfCoachUrl()
    const openGolfCoachUrl = resolved.url

    console.info('[OpenGolfCoach] enrichment request started', {
      helperUrl: openGolfCoachUrl ?? 'unresolved',
      source: resolved.source,
    })
    console.info('[OpenGolfCoach] enrichment request payload', input)

    if (!openGolfCoachUrl) {
      console.warn('[OpenGolfCoach] enrichment skipped: helper URL missing')
      return {
        derivedValues: {},
        payload: null,
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

      console.info('[OpenGolfCoach] enrichment response status', response.status)

      if (!response.ok) {
        console.error('[OpenGolfCoach] enrichment failed: helper returned non-OK', {
          status: response.status,
          statusText: response.statusText,
        })
        return {
          derivedValues: {},
          payload: null,
          status: 'failure',
        }
      }

      const payload: unknown = await response.json()
      console.info('[OpenGolfCoach] enrichment success payload received')

      if (!payload || typeof payload !== 'object') {
        console.error('[OpenGolfCoach] enrichment failed: response payload invalid')
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
      console.error('[OpenGolfCoach] enrichment failure with error', error)
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
