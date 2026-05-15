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
const ENRICHMENT_LOG_FILE_CHANNEL = 'enrichment-pipeline'

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

const isTauriRuntime = () =>
  typeof window !== 'undefined' &&
  Boolean((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)

const appendEnrichmentLog = async (event: string, payload?: Record<string, unknown>) => {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    channel: ENRICHMENT_LOG_FILE_CHANNEL,
    event,
    payload: payload ?? {},
  })

  console.info(`[OpenGolfCoach][${event}]`, payload ?? {})

  if (!isTauriRuntime()) {
    return
  }

  try {
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke
    if (typeof invoke === 'function') {
      await invoke('append_enrichment_log', { line })
    }
  } catch (error) {
    console.error('[OpenGolfCoach] failed to append enrichment log', error)
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

  const isDesktop = isTauriRuntime()
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

    void appendEnrichmentLog('enrichment_attempt', {
      helperUrl: openGolfCoachUrl ?? 'unresolved',
      source: resolved.source,
      input,
    })
    console.info('[OpenGolfCoach] enrichment request started', {
      helperUrl: openGolfCoachUrl ?? 'unresolved',
      source: resolved.source,
    })
    console.info('[OpenGolfCoach] enrichment request payload', input)

    if (!openGolfCoachUrl) {
      void appendEnrichmentLog('enrichment_skipped_not_configured', {
        source: resolved.source,
      })
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
      void appendEnrichmentLog('enrichment_response_status', {
        status: response.status,
        ok: response.ok,
      })

      if (!response.ok) {
        void appendEnrichmentLog('enrichment_failure_http', {
          status: response.status,
          statusText: response.statusText,
        })
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

      const rawResponseText = await response.text()
      console.info('[OpenGolfCoach] enrichment raw response body', rawResponseText)
      void appendEnrichmentLog('enrichment_raw_response', {
        rawResponseText,
      })

      let payload: unknown = null
      try {
        payload = rawResponseText ? JSON.parse(rawResponseText) : {}
      } catch (parseError) {
        void appendEnrichmentLog('enrichment_failure_parse', {
          rawResponseText,
          parseError: parseError instanceof Error ? parseError.message : String(parseError),
        })
        console.error('[OpenGolfCoach] enrichment failed: response JSON parse error', {
          parseError,
          rawResponseText,
        })
        return {
          derivedValues: {},
          payload: null,
          status: 'failure',
        }
      }
      console.info('[OpenGolfCoach] enrichment success payload received')

      if (!payload || typeof payload !== 'object') {
        void appendEnrichmentLog('enrichment_failure_payload_shape', {
          payloadType: typeof payload,
        })
        console.error('[OpenGolfCoach] enrichment failed: response payload invalid')
        return {
          derivedValues: {},
          payload: null,
          status: 'failure',
        }
      }

      void appendEnrichmentLog('enrichment_success', {
        derivedValues: extractOpenGolfCoachDerivedValues(payload as OpenGolfCoachPayload),
      })
      return {
        derivedValues: extractOpenGolfCoachDerivedValues(payload as OpenGolfCoachPayload),
        payload: payload as OpenGolfCoachPayload,
        status: 'success',
      }
    } catch (error) {
      void appendEnrichmentLog('enrichment_failure_fetch', {
        error: error instanceof Error ? error.message : String(error),
      })
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

export const logOpenGolfCoachPipeline = (event: string, payload?: Record<string, unknown>) =>
  void appendEnrichmentLog(event, payload)
