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
const OPEN_GOLF_COACH_DEV_PROXY_URL = '/open-golf-coach'
const ENRICHMENT_LOG_CHANNEL = 'enrichment-pipeline'

const safeLocalStorageGet = (key: string) => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

// Looper is a browser application. Diagnostics stay in the browser console;
// the separately-run localhost service owns any machine-local logging.
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
  if (localUrl) {
    if (
      import.meta.env.DEV &&
      localUrl.replace(/\/+$/, '') === OPEN_GOLF_COACH_DEFAULT_URL
    ) {
      return { url: OPEN_GOLF_COACH_DEV_PROXY_URL, source: 'localStorage' as const }
    }
    return { url: localUrl, source: 'localStorage' as const }
  }

  if (typeof window !== 'undefined') {
    return {
      url: import.meta.env.DEV ? OPEN_GOLF_COACH_DEV_PROXY_URL : OPEN_GOLF_COACH_DEFAULT_URL,
      source: 'localhost_fallback' as const,
    }
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

export const resolveHandedOpenGolfCoachValue = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }

  const handed = value as Record<string, unknown>
  return handed.right_handed ?? handed.left_handed
}

const resolveOpenGolfCoachNumber = (value: unknown) => {
  const resolved = resolveHandedOpenGolfCoachValue(value)
  return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : undefined
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
  const resolvedShotName = resolveHandedOpenGolfCoachValue(coach.shot_name)
  const resolvedShotRank = resolveHandedOpenGolfCoachValue(coach.shot_rank)

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
    club_path_degrees: resolveOpenGolfCoachNumber(coach.club_path_degrees),
    club_face_to_path_degrees: resolveOpenGolfCoachNumber(
      coach.club_face_to_path_degrees,
    ),
    club_face_to_target_degrees: resolveOpenGolfCoachNumber(
      coach.club_face_to_target_degrees,
    ),
    shot_name: typeof resolvedShotName === 'string' ? resolvedShotName : undefined,
    shot_rank:
      typeof resolvedShotRank === 'number' || typeof resolvedShotRank === 'string'
        ? resolvedShotRank
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
