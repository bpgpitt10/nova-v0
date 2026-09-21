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
const ENRICHMENT_LOG_CHANNEL = 'enrichment-pipeline'

const safeLocalStorageGet = (key: string) => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

// The web app never writes native files. Diagnostics stay in the browser
// console; a separately-run localhost helper may expose its own logs.
const appendEnrichmentLog = async (
  event: string,
  payload?: Record<string, unknown>,
) => {
  console.info(`[OpenGolfCoach][${ENRICHMENT_LOG_CHANNEL}][${event}]`, payload ?? {})
}

const resolveOpenGolfCoachUrl = () => {
  const envUrl = (import.meta.env.VITE_OPEN_GOLF_COACH_URL as string | undefined)?.trim()
  if (envUrl) return { url: envUrl, source: 'env' as const }

  const localUrl = safeLocalStorageGet(OPEN_GOLF_COACH_LOCAL_STORAGE_KEY)?.trim()
  if (localUrl) return { url: localUrl, source: 'localStorage' as const }

  // Looper is a browser application. GSPro/local-machine integration is an
  // independent HTTP service, not a native application shell or sidecar.
  if (typeof window !== 'undefined') {
    return { url: OPEN_GOLF_COACH_DEFAULT_URL, source: 'localhost_fallback' as const }
  }

  return { url: undefined, source: 'unresolved' as const }
}

export const isOpenGolfCoachConfigured = Boolean(resolveOpenGolfCoachUrl().url)

export const openGolfCoachEnricher: OpenGolfCoachEnricher = {
  async enrichShot(input) {
    const resolved = resolveOpenGolfCoachUrl()
    const openGolfCoachUrl = resolved.url

    void appendEnrichmentLog('enrichment_attempt', {
      helperUrl: openGolfCoachUrl ?? 'unresolved',
      source: resolved.source,
      input,
    })

    if (!openGolfCoachUrl) {
      void appendEnrichmentLog('enrichment_skipped_not_configured', {
        source: resolved.source,
      })
      return {
        derivedValues: {},
        payload: null,
        status: 'not_configured',
      }
    }

    try {
      const deriveUrl = `${openGolfCoachUrl}/derive`
      void appendEnrichmentLog('derive_request_send', { url: deriveUrl, input })

      const response = await fetch(deriveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })

      void appendEnrichmentLog('derive_response_status', {
        status: response.status,
        ok: response.ok,
      })

      if (!response.ok) {
        void appendEnrichmentLog('enrichment_failure_http', {
          status: response.status,
          statusText: response.statusText,
        })
        return {
          derivedValues: {},
          payload: null,
          status: 'failure',
        }
      }

      const rawResponseText = await response.text()
      let payload: unknown = null

      try {
        payload = rawResponseText ? JSON.parse(rawResponseText) : {}
      } catch (parseError) {
        void appendEnrichmentLog('enrichment_failure_parse', {
          parseError: parseError instanceof Error ? parseError.message : String(parseError),
        })
        return {
          derivedValues: {},
          payload: null,
          status: 'failure',
        }
      }

      if (!payload || typeof payload !== 'object') {
        void appendEnrichmentLog('enrichment_failure_payload_shape', {
          payloadType: typeof payload,
        })
        return {
          derivedValues: {},
          payload: null,
          status: 'failure',
        }
      }

      const typedPayload = payload as OpenGolfCoachPayload
      const derivedValues = extractOpenGolfCoachDerivedValues(typedPayload)
      void appendEnrichmentLog('enrichment_success', { derivedValues })

      return {
        derivedValues,
        payload: typedPayload,
        status: 'success',
      }
    } catch (error) {
      void appendEnrichmentLog('enrichment_failure_fetch', {
        helperUrl: openGolfCoachUrl,
        error: error instanceof Error ? error.message : String(error),
      })
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

export const logOpenGolfCoachPipeline = (
  event: string,
  payload?: Record<string, unknown>,
) => void appendEnrichmentLog(event, payload)
