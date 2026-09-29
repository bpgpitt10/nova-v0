import {
  buildFlightPhysicsPrior,
  windRelativeDegreesForCase,
  type FlightLaunchInput,
} from './flightPhysics'

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

export type WindLaunchEvidence = {
  ballSpeedMph?: number | null
  vlaDeg?: number | null
  hlaDeg?: number | null
  spinRpm?: number | null
  spinAxisDeg?: number | null
  peakHeightFt?: number | null
  descentDeg?: number | null
}

export type WindCalibrationObservation = {
  id: string
  capturedAt: string
  caseId: string
  trajectoryClass: WindTrajectoryClass
  windMph: number
  direction: WindDirectionCase
  launch?: WindLaunchEvidence
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
  physicsPrior?: {
    modelVersion: 'looper-flight-physics-v1'
    carryDeltaYds: number | null
    lateralDeltaYds: number | null
  }
  residual?: {
    carryDeltaYds: number | null
    lateralDeltaYds: number | null
  }
  provenance: 'controlled-gspro'
  note?: string
}

export type WindCalibrationReadiness = {
  totalCases: number
  observedCases: number
  coverage: number
  status: 'empty' | 'partial' | 'broad'
}

export type GsproPhysicsLabImportResult = {
  imported: WindCalibrationObservation[]
  skipped: string[]
  calmShotsFound: number
  conditionedShotsFound: number
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

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const launchInput = (launch?: WindLaunchEvidence): FlightLaunchInput | null => {
  if (!finite(launch?.ballSpeedMph) || !finite(launch?.vlaDeg) || !finite(launch?.spinRpm)) {
    return null
  }
  return {
    ballSpeedMph: launch.ballSpeedMph,
    vlaDeg: launch.vlaDeg,
    hlaDeg: finite(launch.hlaDeg) ? launch.hlaDeg : 0,
    totalSpinRpm: launch.spinRpm,
    spinAxisDeg: finite(launch.spinAxisDeg) ? launch.spinAxisDeg : 0,
  }
}

const physicsEvidence = (
  launch: WindLaunchEvidence | undefined,
  windMph: number,
  direction: WindDirectionCase,
) => {
  const prior = buildFlightPhysicsPrior(launchInput(launch), {
    windMph,
    windRelativeDeg: windRelativeDegreesForCase(direction),
  })
  return {
    modelVersion: prior.modelVersion,
    carryDeltaYds: prior.deltas.windCarryYds,
    lateralDeltaYds: prior.deltas.windLateralYds,
  } as const
}

const difference = (actual: number, prior: number | null) =>
  finite(prior) ? actual - prior : null

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
  launch?: WindLaunchEvidence
  note?: string
  capturedAt?: string
}): WindCalibrationObservation => {
  const caseId = `${input.trajectoryClass}-${input.windMph}-${input.direction}`
  const carryDeltaYds = input.conditionedCarryYds - input.baselineCarryYds
  const lateralDeltaYds = input.conditionedOfflineYds - input.baselineOfflineYds
  const prior = physicsEvidence(input.launch, input.windMph, input.direction)
  return {
    id: `${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
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
    carryDeltaYds,
    lateralDeltaYds,
    physicsPrior: prior,
    residual: {
      carryDeltaYds: difference(carryDeltaYds, prior.carryDeltaYds),
      lateralDeltaYds: difference(lateralDeltaYds, prior.lateralDeltaYds),
    },
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

const normalizedDegrees = (value: number) => ((value % 360) + 360) % 360

export const windDirectionFromRelativeDegrees = (value: number): WindDirectionCase | null => {
  const degree = normalizedDegrees(value)
  const options: Array<[number, WindDirectionCase]> = [
    [0, 'head'],
    [45, 'head-right'],
    [90, 'right-cross'],
    [135, 'tail-right'],
    [180, 'tail'],
    [225, 'tail-left'],
    [270, 'left-cross'],
    [315, 'head-left'],
  ]
  const matched = options.find(([candidate]) => Math.abs(candidate - degree) < 0.01)
  return matched?.[1] ?? null
}

type PhysicsLabShot = {
  capturedAt?: unknown
  condition?: {
    windMph?: unknown
    windRelativeDeg?: unknown
    label?: unknown
  }
  launch?: {
    ballSpeedMph?: unknown
    vlaDeg?: unknown
    hlaDeg?: unknown
    spinRpm?: unknown
    spinAxisDeg?: unknown
  }
  carryYds?: unknown
  offlineYds?: unknown
  peakHeightYds?: unknown
  descentAngleDeg?: unknown
}

type PhysicsLabFile = {
  schemaVersion?: unknown
  observations?: unknown
}

const launchSignature = (shot: PhysicsLabShot) => {
  const launch = shot.launch
  if (
    !finite(launch?.ballSpeedMph) ||
    !finite(launch?.vlaDeg) ||
    !finite(launch?.spinRpm)
  ) return null
  return [
    launch.ballSpeedMph.toFixed(3),
    launch.vlaDeg.toFixed(3),
    finite(launch.hlaDeg) ? launch.hlaDeg.toFixed(3) : '0.000',
    launch.spinRpm.toFixed(1),
    finite(launch.spinAxisDeg) ? launch.spinAxisDeg.toFixed(3) : '0.000',
  ].join('|')
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

export const importGsproPhysicsLab = (
  payload: unknown,
  trajectoryClass: WindTrajectoryClass,
): GsproPhysicsLabImportResult => {
  const file = payload as PhysicsLabFile
  if (file?.schemaVersion !== 'looper-gspro-physics-lab-v1' || !Array.isArray(file.observations)) {
    throw new Error('Not a Looper GSPro physics-lab v1 file.')
  }

  const shots = file.observations.filter(
    (value): value is PhysicsLabShot => Boolean(value) && typeof value === 'object',
  )
  const calmByLaunch = new Map<string, PhysicsLabShot[]>()
  const conditioned: PhysicsLabShot[] = []
  const skipped: string[] = []

  for (const shot of shots) {
    const signature = launchSignature(shot)
    const windMph = shot.condition?.windMph
    if (!signature || !finite(windMph) || !finite(shot.carryYds) || !finite(shot.offlineYds)) {
      skipped.push('Skipped a shot missing launch, wind, carry, or offline data.')
      continue
    }
    if (Math.abs(windMph) < 0.01) {
      const existing = calmByLaunch.get(signature) ?? []
      existing.push(shot)
      calmByLaunch.set(signature, existing)
    } else {
      conditioned.push(shot)
    }
  }

  const imported: WindCalibrationObservation[] = []
  for (const shot of conditioned) {
    const signature = launchSignature(shot)
    if (!signature) continue
    const baselineShots = calmByLaunch.get(signature)
    if (!baselineShots?.length) {
      skipped.push(`No calm baseline found for conditioned launch ${signature}.`)
      continue
    }
    const windMph = shot.condition?.windMph
    const relative = shot.condition?.windRelativeDeg
    if (!finite(windMph) || !WIND_SPEEDS.includes(windMph as (typeof WIND_SPEEDS)[number])) {
      skipped.push(`Wind speed ${String(windMph)} mph is outside the current 5/10/15 mph calibration matrix.`)
      continue
    }
    if (!finite(relative)) {
      skipped.push('Conditioned shot did not include a relative wind direction.')
      continue
    }
    const direction = windDirectionFromRelativeDegrees(relative)
    if (!direction) {
      skipped.push(`Wind direction ${relative}° is outside the current 45° calibration grid.`)
      continue
    }

    const baselineCarry = mean(baselineShots.map((item) => item.carryYds).filter(finite))
    const baselineOffline = mean(baselineShots.map((item) => item.offlineYds).filter(finite))
    const launch = shot.launch
    imported.push(createWindCalibrationObservation({
      trajectoryClass,
      windMph,
      direction,
      baselineCarryYds: baselineCarry,
      baselineOfflineYds: baselineOffline,
      conditionedCarryYds: shot.carryYds as number,
      conditionedOfflineYds: shot.offlineYds as number,
      launch: {
        ballSpeedMph: launch?.ballSpeedMph as number,
        vlaDeg: launch?.vlaDeg as number,
        hlaDeg: finite(launch?.hlaDeg) ? launch.hlaDeg : 0,
        spinRpm: launch?.spinRpm as number,
        spinAxisDeg: finite(launch?.spinAxisDeg) ? launch.spinAxisDeg : 0,
        peakHeightFt: finite(shot.peakHeightYds) ? shot.peakHeightYds * 3 : null,
        descentDeg: finite(shot.descentAngleDeg) ? shot.descentAngleDeg : null,
      },
      capturedAt: typeof shot.capturedAt === 'string' ? shot.capturedAt : undefined,
      note: `Imported from local GSPro physics lab${typeof shot.condition?.label === 'string' ? ` · ${shot.condition.label}` : ''}`,
    }))
  }

  return {
    imported,
    skipped,
    calmShotsFound: Array.from(calmByLaunch.values()).reduce((sum, group) => sum + group.length, 0),
    conditionedShotsFound: conditioned.length,
  }
}
