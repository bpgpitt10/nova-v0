export type WindTrajectoryClass = 'driver' | 'hybrid' | 'mid-iron' | 'pw' | 'wedge'

export type WindDirectionCase =
  | 'head'
  | 'tail'
  | 'left-cross'
  | 'right-cross'
  | 'head-left'
  | 'head-right'
  | 'tail-left'
  | 'tail-right'

export type WindCalibrationCase = {
  id: string
  trajectoryClass: WindTrajectoryClass
  windMph: 5 | 10 | 15
  direction: WindDirectionCase
}

export type WindCalibrationObservation = {
  id: string
  capturedAt: string
  caseId: string
  trajectoryClass: WindTrajectoryClass
  windMph: number
  direction: WindDirectionCase
  launch?: {
    ballSpeedMph?: number | null
    vlaDeg?: number | null
    hlaDeg?: number | null
    spinRpm?: number | null
    spinAxisDeg?: number | null
    peakHeightFt?: number | null
    descentDeg?: number | null
  }
  baseline: {
    carryYds: number
    offlineYds: number
  }
  conditioned: {
    carryYds: number
    offlineYds: number
  }
  carryDeltaYds: number
  lateralDeltaYds: number
  provenance: 'controlled-gspro'
  note?: string
}

export type WindCalibrationReadiness = {
  totalCases: number
  observedCases: number
  coverage: number
  status: 'empty' | 'partial' | 'broad'
}

export const WIND_TRAJECTORY_CLASSES: readonly WindTrajectoryClass[] = [
  'driver',
  'hybrid',
  'mid-iron',
  'pw',
  'wedge',
]

export const WIND_DIRECTIONS: readonly WindDirectionCase[] = [
  'head',
  'tail',
  'left-cross',
  'right-cross',
  'head-left',
  'head-right',
  'tail-left',
  'tail-right',
]

export const WIND_SPEEDS = [5, 10, 15] as const

export const buildWindCalibrationMatrix = (): WindCalibrationCase[] =>
  WIND_TRAJECTORY_CLASSES.flatMap((trajectoryClass) =>
    WIND_SPEEDS.flatMap((windMph) =>
      WIND_DIRECTIONS.map((direction) => ({
        id: `${trajectoryClass}-${windMph}-${direction}`,
        trajectoryClass,
        windMph,
        direction,
      })),
    ),
  )

const STORAGE_KEY = 'looper:wind-calibration:v1'

export const loadWindCalibrationObservations = (): WindCalibrationObservation[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const saveWindCalibrationObservations = (
  observations: readonly WindCalibrationObservation[],
) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(observations))
}

export const createWindCalibrationObservation = (input: {
  trajectoryClass: WindTrajectoryClass
  windMph: number
  direction: WindDirectionCase
  baselineCarryYds: number
  baselineOfflineYds: number
  conditionedCarryYds: number
  conditionedOfflineYds: number
  launch?: WindCalibrationObservation['launch']
  note?: string
}): WindCalibrationObservation => {
  const caseId = `${input.trajectoryClass}-${input.windMph}-${input.direction}`
  return {
    id: `${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: new Date().toISOString(),
    caseId,
    trajectoryClass: input.trajectoryClass,
    windMph: input.windMph,
    direction: input.direction,
    launch: input.launch,
    baseline: {
      carryYds: input.baselineCarryYds,
      offlineYds: input.baselineOfflineYds,
    },
    conditioned: {
      carryYds: input.conditionedCarryYds,
      offlineYds: input.conditionedOfflineYds,
    },
    carryDeltaYds: input.conditionedCarryYds - input.baselineCarryYds,
    lateralDeltaYds: input.conditionedOfflineYds - input.baselineOfflineYds,
    provenance: 'controlled-gspro',
    note: input.note,
  }
}

export const windCalibrationReadiness = (
  observations: readonly WindCalibrationObservation[],
): WindCalibrationReadiness => {
  const matrix = buildWindCalibrationMatrix()
  const observed = new Set(observations.map((observation) => observation.caseId))
  const observedCases = matrix.filter((item) => observed.has(item.id)).length
  const coverage = observedCases / matrix.length
  return {
    totalCases: matrix.length,
    observedCases,
    coverage,
    status: observedCases === 0 ? 'empty' : coverage >= 0.7 ? 'broad' : 'partial',
  }
}

export const windDirectionLabel = (direction: WindDirectionCase) => {
  switch (direction) {
    case 'head': return 'Headwind'
    case 'tail': return 'Tailwind'
    case 'left-cross': return 'Crosswind from left'
    case 'right-cross': return 'Crosswind from right'
    case 'head-left': return 'Headwind + from left'
    case 'head-right': return 'Headwind + from right'
    case 'tail-left': return 'Tailwind + from left'
    case 'tail-right': return 'Tailwind + from right'
  }
}
