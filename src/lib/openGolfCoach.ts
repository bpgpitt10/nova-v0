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

const OPEN_GOLF_COACH_WEB_API_BASE = '/api/open-golf-coach'
const ENRICHMENT_LOG_CHANNEL = 'enrichment-pipeline'
const OPEN_GOLF_COACH_REQUIRED_INPUT_FIELDS = [
  'ball_speed_meters_per_second',
  'vertical_launch_angle_degrees',
  'horizontal_launch_angle_degrees',
  'total_spin_rpm',
  'spin_axis_degrees',
] as const satisfies readonly (keyof OpenGolfCoachInput)[]

const appendEnrichmentLog = async (event: string, payload?: Record<string, unknown>) => {
  console.info(`[OpenGolfCoach][${ENRICHMENT_LOG_CHANNEL}][${event}]`, payload ?? {})
}

const resolveOpenGolfCoachUrl = () => {
  const envUrl = (import.meta.env.VITE_OPEN_GOLF_COACH_URL as string | undefined)?.trim()
  if (envUrl) {
    return { url: envUrl.replace(/\/+$/, ''), source: 'env' as const }
  }

  return { url: OPEN_GOLF_COACH_WEB_API_BASE, source: 'web_api' as const }
}

export const missingOpenGolfCoachInputFields = (input: OpenGolfCoachInput) =>
  OPEN_GOLF_COACH_REQUIRED_INPUT_FIELDS.filter((field) => {
    const value = input[field]
    return typeof value !== 'number' || !Number.isFinite(value)
  })

// The web application always has an OGC endpoint contract. Whether that endpoint
// is deployed/healthy is handled as a normal request failure rather than by
// launching or probing a local helper process.
export const isOpenGolfCoachConfigured = true

// GSPro owns measured launch/outcome data. OGC is a server-side interpretation
// service that consumes normalized launch/spin inputs and returns compatible
// Looper enrichment fields such as shot name/rank and other derived values.
export const openGolfCoachEnricher: OpenGolfCoachEnricher = {
  async enrichShot(input) {
    const missingFields = missingOpenGolfCoachInputFields(input)
    if (missingFields.length > 0) {
      void appendEnrichmentLog('enrichment_skipped_incomplete_input', {
        missingFields: [...missingFields],
        input,
      })
      return {
        derivedValues: {},
        payload: null,
        status: 'failure',
      }
    }

    const resolved = resolveOpenGolfCoachUrl()
    const openGolfCoachUrl = resolved.url

    void appendEnrichmentLog('enrichment_attempt', {
      apiBase: openGolfCoachUrl,
      source: resolved.source,
      input,
    })

    try {
      const response = await fetch(`${openGolfCoachUrl}/derive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      })

      void appendEnrichmentLog('enrichment_response_status', {
        status: response.status,
        ok: response.ok,
      })

      if (!response.ok) {
        const responseText = await response.text().catch(() => '')
        void appendEnrichmentLog('enrichment_failure_http', {
          status: response.status,
          statusText: response.statusText,
          responseText,
        })
        return {
          derivedValues: {},
          payload: null,
          status: 'failure',
        }
      }

      const rawResponseText = await response.text()
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

      const derivedValues = extractOpenGolfCoachDerivedValues(payload as OpenGolfCoachPayload)
      void appendEnrichmentLog('enrichment_success', { derivedValues })

      return {
        derivedValues,
        payload: payload as OpenGolfCoachPayload,
        status: 'success',
      }
    } catch (error) {
      void appendEnrichmentLog('enrichment_failure_fetch', {
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
  missingOpenGolfCoachInputFields(input).length === 0

export const logOpenGolfCoachPipeline = (event: string, payload?: Record<string, unknown>) =>
  void appendEnrichmentLog(event, payload)
