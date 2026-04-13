import type {
  OpenGolfCoachDerivedValues,
  OpenGolfCoachInput,
} from '../types'
import initWasm, { calculate_derived_values } from './opengolfcoach-wasm/opengolfcoach'

export type OpenGolfCoachEnrichmentResult = {
  derivedValues: OpenGolfCoachDerivedValues
  status: 'not_configured' | 'success' | 'failure'
}

export type OpenGolfCoachEnricher = {
  enrichShot: (
    input: OpenGolfCoachInput,
  ) => Promise<OpenGolfCoachEnrichmentResult>
}

let wasmReady: Promise<void> | null = null

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm().then(() => {
      console.info('[OpenGolfCoach] WASM initialized')
    }).catch((err) => {
      console.error('[OpenGolfCoach] WASM init failed:', err)
      wasmReady = null
      throw err
    })
  }
  return wasmReady
}

export const isOpenGolfCoachConfigured = true

export const openGolfCoachEnricher: OpenGolfCoachEnricher = {
  async enrichShot(input) {
    try {
      await ensureWasm()

      const jsonOutput = calculate_derived_values(JSON.stringify(input))
      const result = JSON.parse(jsonOutput)

      const coach = result.open_golf_coach || result
      const customary = coach.us_customary_units || {}

      const derivedValues: OpenGolfCoachDerivedValues = {
        carry_distance_yards: customary.carry_distance_yards,
        total_distance_yards: customary.total_distance_yards,
        offline_distance_yards: customary.offline_distance_yards,
        shot_name: coach.shot_name,
        shot_rank: coach.shot_rank,
      }

      return {
        derivedValues,
        status: 'success',
      }
    } catch (error) {
      console.error('[OpenGolfCoach] enrichment failed:', error)
      return {
        derivedValues: {},
        status: 'failure',
      }
    }
  },
}

export const buildOpenGolfCoachInput = (
  shot: import('../types').IncomingNovaShot,
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
