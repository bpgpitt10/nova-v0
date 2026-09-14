export type FlightLaunchInput = {
  ballSpeedMph: number
  vlaDeg: number
  hlaDeg?: number
  totalSpinRpm: number
  spinAxisDeg?: number
}

export type FlightEnvironmentInput = {
  windMph?: number
  /** Wind direction the air is coming FROM relative to target line: 0=headwind, 90=from right, 180=tailwind, 270=from left. */
  windRelativeDeg?: number
  /** Candidate landing elevation relative to the ball. Intersected only on the descending branch. */
  landingElevationDeltaFt?: number
  temperatureF?: number
  airAltitudeFt?: number
}

export type FlightSimulationResult = {
  ok: boolean
  carryYds: number | null
  offlineYds: number | null
  apexFt: number | null
  flightTimeS: number | null
  landingSpeedMph: number | null
  landingAngleDeg: number | null
  initialReynolds: number | null
  initialSpinRatio: number | null
  initialCd: number | null
  initialCl: number | null
  failureReason?: string
}

export type FlightPhysicsPrior = {
  modelVersion: 'looper-flight-physics-v1'
  sourceModel: 'OpenFairway-derived-aerodynamics'
  status: 'ready' | 'unavailable'
  launch: FlightLaunchInput | null
  baseline: FlightSimulationResult | null
  windOnly: FlightSimulationResult | null
  elevationOnly: FlightSimulationResult | null
  combined: FlightSimulationResult | null
  deltas: {
    windCarryYds: number | null
    windLateralYds: number | null
    elevationCarryYds: number | null
    combinedCarryYds: number | null
    combinedLateralYds: number | null
  }
  notes: readonly string[]
}

type Vec3 = { x: number; y: number; z: number }

type AeroSample = {
  speed: number
  reynolds: number
  spinRatio: number
  cd: number
  cl: number
}

const BALL_MASS_KG = 0.04592623
const BALL_RADIUS_M = 0.021335
const BALL_AREA_M2 = Math.PI * BALL_RADIUS_M * BALL_RADIUS_M
const GRAVITY_MPS2 = 9.80665
const SIMULATION_DT_S = 1 / 120
const MAX_FLIGHT_TIME_S = 15
const SPIN_DECAY_TAU_S = 5
const MPH_TO_MPS = 0.44704
const MPS_TO_MPH = 1 / MPH_TO_MPS
const RPM_TO_RAD_PER_S = (2 * Math.PI) / 60
const YARDS_PER_METER = 1.09361
const FEET_PER_METER = 3.28084
const FEET_TO_METERS = 0.3048

const profile = {
  cdPolyA: 1.1948,
  cdPolyB: -0.0000209661,
  cdPolyC: 1.42472e-10,
  cdPolyD: -3.14383e-16,
  highReCdCap: 0.2,
  lowReCdFloor: 0.38,
  lowReBlendStart: 30000,
  cdAt50k: 0.4632,
  clMaxBase: 0.268,
  clMaxHighSpin: 0.32,
  clMaxSrTransitionStart: 0.35,
  clMaxSrTransitionEnd: 0.5,
  spinDragMultiplierCoeff: 4,
  spinDragMultiplierMax: 1.2,
  spinDragMultiplierHighSpinMax: 1.03,
  spinDragMultiplierUltraHighSpinMax: 1.21,
  highSpinDragSrStart: 0.3,
  highSpinDragSrEnd: 0.48,
  highSpinDragReliefReFullMax: 90000,
  highSpinDragReliefReZero: 105000,
  ultraHighSpinDragSrStart: 0.57,
  ultraHighSpinDragSrEnd: 0.77,
  highReStart: 75000,
  highReMidSpinGain: 16,
  highReSpinGain: 16,
  highReGainReductionStart: 0.1,
  highReGainReductionEnd: 0.18,
  highReGainRecoveryStart: 0.26,
  highReGainRecoveryEnd: 0.4,
  highSpinClAttenuationStart: 0.45,
  highSpinClAttenuationEnd: 0.55,
  highSpinClAttenuationMax: 0.09,
  ultraHighSpinClAttenuationStart: 0.58,
  ultraHighSpinClAttenuationEnd: 0.85,
  ultraHighSpinClAttenuationMax: 0.1,
  lowReHighSpinClAttenuationMax: 0.1,
  lowReUltraHighSpinClAttenuationMax: 0.06,
  lowLaunchLiftRecoveryMax: 1.08,
  lowLaunchVlaFullDeg: 6.5,
  lowLaunchVlaZeroDeg: 9.5,
  lowLaunchReStart: 85000,
  lowLaunchReEnd: 110000,
  lowLaunchSpinRatioFull: 0.18,
  lowLaunchSpinRatioMax: 0.22,
  highLaunchDragBoostMax: 1.24,
  highLaunchDragVlaStartDeg: 24.5,
  highLaunchDragVlaFullDeg: 31.5,
  highLaunchDragSrStart: 0.5,
  highLaunchDragSrEnd: 0.7,
  spinDragProgressiveCapSrStart: 0.33,
  spinDragProgressiveCapSrEnd: 0.5,
  spinDragProgressiveCapBoostMax: 0.25,
  midSpinClBoostSrStart: 0.17,
  midSpinClBoostSrEnd: 0.31,
  midSpinClBoostMax: 0.45,
} as const

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const degToRad = (value: number) => (value * Math.PI) / 180
const radToDeg = (value: number) => (value * 180) / Math.PI

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const scale = (v: Vec3, amount: number): Vec3 => ({ x: v.x * amount, y: v.y * amount, z: v.z * amount })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const length = (v: Vec3) => Math.sqrt(dot(v, v))
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

const smoothStep01 = (value: number) => {
  const t = clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

const safeSmoothStep01 = (value: number, start: number, end: number) => {
  const range = end - start
  if (Math.abs(range) < 1e-9) return value >= end ? 1 : 0
  return smoothStep01((value - start) / range)
}

const airDensity = (altitudeFt: number, temperatureF: number) => {
  const kelvinCelsius = 273.15
  const pressureSeaLevelPa = 101325
  const molarMassDryAir = 0.0289644
  const universalGasConstant = 8.314462618
  const gasConstantDryAir = 287.058
  const tempK = ((temperatureF - 32) * 5) / 9 + kelvinCelsius
  const altitudeM = altitudeFt * FEET_TO_METERS
  const exponent = (-GRAVITY_MPS2 * molarMassDryAir * altitudeM) / (universalGasConstant * tempK)
  const pressure = pressureSeaLevelPa * Math.exp(exponent)
  return pressure / (gasConstantDryAir * tempK)
}

const dynamicViscosity = (temperatureF: number) => {
  const kelvinCelsius = 273.15
  const viscosityAtZeroC = 1.716e-5
  const sutherlandConstant = 198.72
  const tempK = ((temperatureF - 32) * 5) / 9 + kelvinCelsius
  return viscosityAtZeroC * Math.pow(tempK / kelvinCelsius, 1.5) *
    ((kelvinCelsius + sutherlandConstant) / (tempK + sutherlandConstant))
}

const dragCoefficient = (reynolds: number) => {
  if (reynolds > 200000) return profile.highReCdCap
  if (reynolds >= 50000) {
    return profile.cdPolyA +
      profile.cdPolyB * reynolds +
      profile.cdPolyC * reynolds * reynolds +
      profile.cdPolyD * reynolds * reynolds * reynolds
  }
  if (reynolds <= profile.lowReBlendStart) return profile.lowReCdFloor
  return lerp(
    profile.lowReCdFloor,
    profile.cdAt50k,
    safeSmoothStep01(reynolds, profile.lowReBlendStart, 50000),
  )
}

const liftCap = (spinRatio: number) => {
  if (spinRatio <= profile.clMaxSrTransitionStart) return profile.clMaxBase
  if (spinRatio >= profile.clMaxSrTransitionEnd) return profile.clMaxHighSpin
  return lerp(
    profile.clMaxBase,
    profile.clMaxHighSpin,
    safeSmoothStep01(spinRatio, profile.clMaxSrTransitionStart, profile.clMaxSrTransitionEnd),
  )
}

const highReSpinGain = (spinRatio: number) => {
  if (spinRatio <= profile.highReGainReductionStart) return profile.highReSpinGain
  if (spinRatio < profile.highReGainReductionEnd) {
    return lerp(
      profile.highReSpinGain,
      profile.highReMidSpinGain,
      safeSmoothStep01(spinRatio, profile.highReGainReductionStart, profile.highReGainReductionEnd),
    )
  }
  if (spinRatio <= profile.highReGainRecoveryStart) return profile.highReMidSpinGain
  if (spinRatio < profile.highReGainRecoveryEnd) {
    return lerp(
      profile.highReMidSpinGain,
      profile.highReSpinGain,
      safeSmoothStep01(spinRatio, profile.highReGainRecoveryStart, profile.highReGainRecoveryEnd),
    )
  }
  return profile.highReSpinGain
}

const cl50 = (spinRatio: number) =>
  0.0472121 + 2.84795 * spinRatio - 23.4342 * spinRatio * spinRatio + 45.4849 * spinRatio ** 3
const cl60 = (spinRatio: number) => 0.320524 - 4.7032 * spinRatio + 14.0613 * spinRatio * spinRatio
const cl65 = (spinRatio: number) => 0.266667 - 4 * spinRatio + 13.3333 * spinRatio * spinRatio
const cl70 = (spinRatio: number) => 0.0496189 + 0.00211396 * spinRatio + 2.34201 * spinRatio * spinRatio
const clHigh = (spinRatio: number) => {
  const gain = highReSpinGain(spinRatio)
  const cap = liftCap(spinRatio)
  return (cap * spinRatio * gain) / (1 + spinRatio * gain)
}

const attenuateHighSpinLift = (spinRatio: number, cl: number, lowRe: boolean) => {
  const normalMax = lowRe ? profile.lowReHighSpinClAttenuationMax : profile.highSpinClAttenuationMax
  const ultraMax = lowRe ? profile.lowReUltraHighSpinClAttenuationMax : profile.ultraHighSpinClAttenuationMax
  const normal = 1 - normalMax * safeSmoothStep01(
    spinRatio,
    profile.highSpinClAttenuationStart,
    profile.highSpinClAttenuationEnd,
  )
  const ultra = 1 - ultraMax * safeSmoothStep01(
    spinRatio,
    profile.ultraHighSpinClAttenuationStart,
    profile.ultraHighSpinClAttenuationEnd,
  )
  return cl * normal * ultra
}

const liftCoefficient = (reynolds: number, spinRatioRaw: number) => {
  const spinRatio = Math.max(0, spinRatioRaw)
  if (spinRatio <= 0) return 0
  const cap = liftCap(spinRatio)
  if (reynolds < 50000) {
    if (reynolds <= 30000) return 0
    const value = clamp(cl50(spinRatio), 0, cap) * smoothStep01((reynolds - 30000) / 20000)
    return attenuateHighSpinLift(spinRatio, value, true)
  }
  if (reynolds >= profile.highReStart) {
    return attenuateHighSpinLift(spinRatio, clamp(clHigh(spinRatio), 0, cap), false)
  }
  const reValues = [50000, 60000, 65000, 70000, 75000]
  const curves = [cl50, cl60, cl65, cl70, clHigh]
  let highIndex = reValues.length - 1
  for (let i = 0; i < reValues.length; i += 1) {
    if (reynolds <= reValues[i]) {
      highIndex = i
      break
    }
  }
  const lowIndex = Math.max(highIndex - 1, 0)
  const lowReynolds = reValues[lowIndex]
  const highReynolds = reValues[highIndex]
  const weight = highReynolds === lowReynolds ? 0 : (reynolds - lowReynolds) / (highReynolds - lowReynolds)
  const interpolated = lerp(
    Math.max(0, curves[lowIndex](spinRatio)),
    Math.max(0, curves[highIndex](spinRatio)),
    weight,
  )
  return attenuateHighSpinLift(spinRatio, clamp(interpolated, 0, cap), true)
}

const sampleAerodynamics = (
  airVelocity: Vec3,
  omega: Vec3,
  rho: number,
  viscosity: number,
  initialVlaDeg: number,
): AeroSample => {
  const speed = length(airVelocity)
  if (speed < 0.5) return { speed, reynolds: 0, spinRatio: 0, cd: 0, cl: 0 }
  const spinRatio = (length(omega) * BALL_RADIUS_M) / speed
  const reynolds = (rho * speed * BALL_RADIUS_M * 2) / viscosity

  const highSpinWeight = safeSmoothStep01(spinRatio, profile.highSpinDragSrStart, profile.highSpinDragSrEnd)
  const reReliefWeight = 1 - safeSmoothStep01(
    reynolds,
    profile.highSpinDragReliefReFullMax,
    profile.highSpinDragReliefReZero,
  )
  let spinDragCap = lerp(
    profile.spinDragMultiplierMax,
    profile.spinDragMultiplierHighSpinMax,
    highSpinWeight * reReliefWeight,
  )
  spinDragCap += profile.spinDragProgressiveCapBoostMax * safeSmoothStep01(
    spinRatio,
    profile.spinDragProgressiveCapSrStart,
    profile.spinDragProgressiveCapSrEnd,
  )
  spinDragCap = lerp(
    spinDragCap,
    profile.spinDragMultiplierUltraHighSpinMax,
    safeSmoothStep01(spinRatio, profile.ultraHighSpinDragSrStart, profile.ultraHighSpinDragSrEnd),
  )
  const spinDrag = Math.min(1 + profile.spinDragMultiplierCoeff * spinRatio * spinRatio, spinDragCap)

  const lowLaunchFactor = safeSmoothStep01(
    profile.lowLaunchVlaZeroDeg - initialVlaDeg,
    0,
    profile.lowLaunchVlaZeroDeg - profile.lowLaunchVlaFullDeg,
  )
  const lowLaunchRe = safeSmoothStep01(reynolds, profile.lowLaunchReStart, profile.lowLaunchReEnd)
  const lowLaunchSpin = 1 - safeSmoothStep01(
    spinRatio,
    profile.lowLaunchSpinRatioFull,
    profile.lowLaunchSpinRatioMax,
  )
  const lowLaunchLiftScale = lerp(
    1,
    profile.lowLaunchLiftRecoveryMax,
    Math.max(0, lowLaunchFactor * lowLaunchRe * lowLaunchSpin),
  )

  const highLaunchDragScale = lerp(
    1,
    profile.highLaunchDragBoostMax,
    safeSmoothStep01(initialVlaDeg, profile.highLaunchDragVlaStartDeg, profile.highLaunchDragVlaFullDeg) *
      safeSmoothStep01(spinRatio, profile.highLaunchDragSrStart, profile.highLaunchDragSrEnd),
  )

  const midSpinT = safeSmoothStep01(spinRatio, profile.midSpinClBoostSrStart, profile.midSpinClBoostSrEnd)
  const midSpinLiftScale = 1 + profile.midSpinClBoostMax * (midSpinT * (1 - midSpinT) * 4)

  return {
    speed,
    reynolds,
    spinRatio,
    cd: dragCoefficient(reynolds) * spinDrag * highLaunchDragScale,
    cl: liftCoefficient(reynolds, spinRatio) * lowLaunchLiftScale * midSpinLiftScale,
  }
}

const launchVectors = (launch: FlightLaunchInput) => {
  const speed = launch.ballSpeedMph * MPH_TO_MPS
  const vla = degToRad(launch.vlaDeg)
  const hla = degToRad(launch.hlaDeg ?? 0)
  const axis = degToRad(launch.spinAxisDeg ?? 0)
  const forward: Vec3 = { x: Math.sin(hla), y: 0, z: Math.cos(hla) }
  const right: Vec3 = { x: Math.cos(hla), y: 0, z: -Math.sin(hla) }
  const velocity: Vec3 = {
    x: speed * Math.cos(vla) * Math.sin(hla),
    y: speed * Math.sin(vla),
    z: speed * Math.cos(vla) * Math.cos(hla),
  }
  const backspin = launch.totalSpinRpm * Math.cos(axis) * RPM_TO_RAD_PER_S
  const sidespin = launch.totalSpinRpm * Math.sin(axis) * RPM_TO_RAD_PER_S
  const omega = add(scale(right, -backspin), { x: 0, y: sidespin, z: 0 })
  return { velocity, omega, forward, right }
}

const windVector = (forward: Vec3, right: Vec3, windMph: number, windRelativeDeg: number) => {
  const speed = Math.max(0, windMph) * MPH_TO_MPS
  const angle = degToRad(windRelativeDeg)
  // Direction describes where wind comes FROM. Headwind therefore has air moving opposite the shot.
  return add(
    scale(forward, -Math.cos(angle) * speed),
    scale(right, -Math.sin(angle) * speed),
  )
}

export const simulateFlight = (
  launch: FlightLaunchInput,
  environment: FlightEnvironmentInput = {},
): FlightSimulationResult => {
  if (
    !finite(launch.ballSpeedMph) || launch.ballSpeedMph <= 0 ||
    !finite(launch.vlaDeg) ||
    !finite(launch.totalSpinRpm) || launch.totalSpinRpm < 0
  ) {
    return {
      ok: false,
      carryYds: null,
      offlineYds: null,
      apexFt: null,
      flightTimeS: null,
      landingSpeedMph: null,
      landingAngleDeg: null,
      initialReynolds: null,
      initialSpinRatio: null,
      initialCd: null,
      initialCl: null,
      failureReason: 'Launch packet is incomplete or invalid.',
    }
  }

  const { velocity: initialVelocity, omega: initialOmega, forward, right } = launchVectors(launch)
  let velocity = initialVelocity
  let omega = initialOmega
  let position: Vec3 = { x: 0, y: 0.02, z: 0 }
  let apexM = position.y
  let descending = false

  const temperatureF = finite(environment.temperatureF) ? environment.temperatureF : 75
  const altitudeFt = finite(environment.airAltitudeFt) ? environment.airAltitudeFt : 0
  const rho = airDensity(altitudeFt, temperatureF)
  const viscosity = dynamicViscosity(temperatureF)
  const wind = windVector(
    forward,
    right,
    environment.windMph ?? 0,
    environment.windRelativeDeg ?? 0,
  )
  const targetElevationM = (environment.landingElevationDeltaFt ?? 0) * FEET_TO_METERS
  const initialAirVelocity = sub(initialVelocity, wind)
  const initialSample = sampleAerodynamics(initialAirVelocity, initialOmega, rho, viscosity, launch.vlaDeg)

  const steps = Math.floor(MAX_FLIGHT_TIME_S / SIMULATION_DT_S)
  for (let i = 0; i < steps; i += 1) {
    const previousPosition = position
    const airVelocity = sub(velocity, wind)
    const sample = sampleAerodynamics(airVelocity, omega, rho, viscosity, launch.vlaDeg)
    const drag = sample.speed > 0
      ? scale(airVelocity, -0.5 * sample.cd * rho * BALL_AREA_M2 * sample.speed)
      : { x: 0, y: 0, z: 0 }
    const omegaMagnitude = length(omega)
    const magnus = omegaMagnitude > 0.1 && sample.speed > 0
      ? scale(
          cross(omega, airVelocity),
          (0.5 * sample.cl * rho * BALL_AREA_M2 * sample.speed) / omegaMagnitude,
        )
      : { x: 0, y: 0, z: 0 }
    const acceleration = add(
      scale(add(drag, magnus), 1 / BALL_MASS_KG),
      { x: 0, y: -GRAVITY_MPS2, z: 0 },
    )

    velocity = add(velocity, scale(acceleration, SIMULATION_DT_S))
    omega = add(omega, scale(omega, -SIMULATION_DT_S / SPIN_DECAY_TAU_S))
    position = add(position, scale(velocity, SIMULATION_DT_S))
    apexM = Math.max(apexM, position.y)
    if (velocity.y <= 0) descending = true

    if (descending && position.y <= targetElevationM) {
      const verticalTravel = previousPosition.y - position.y
      const fraction = Math.abs(verticalTravel) < 1e-9
        ? 1
        : clamp((previousPosition.y - targetElevationM) / verticalTravel, 0, 1)
      const landing = add(previousPosition, scale(sub(position, previousPosition), fraction))
      const forwardVelocity = dot(velocity, forward)
      const lateralVelocity = dot(velocity, right)
      const horizontalSpeed = Math.sqrt(forwardVelocity ** 2 + lateralVelocity ** 2)
      return {
        ok: true,
        carryYds: dot(landing, forward) * YARDS_PER_METER,
        offlineYds: dot(landing, right) * YARDS_PER_METER,
        apexFt: apexM * FEET_PER_METER,
        flightTimeS: (i + fraction) * SIMULATION_DT_S,
        landingSpeedMph: length(velocity) * MPS_TO_MPH,
        landingAngleDeg: radToDeg(Math.atan2(Math.abs(velocity.y), Math.max(horizontalSpeed, 1e-6))),
        initialReynolds: initialSample.reynolds,
        initialSpinRatio: initialSample.spinRatio,
        initialCd: initialSample.cd,
        initialCl: initialSample.cl,
      }
    }
  }

  return {
    ok: false,
    carryYds: null,
    offlineYds: null,
    apexFt: apexM * FEET_PER_METER,
    flightTimeS: null,
    landingSpeedMph: null,
    landingAngleDeg: null,
    initialReynolds: initialSample.reynolds,
    initialSpinRatio: initialSample.spinRatio,
    initialCd: initialSample.cd,
    initialCl: initialSample.cl,
    failureReason: 'Trajectory did not intersect the candidate landing elevation on the descending branch.',
  }
}

const resultDelta = (
  conditioned: FlightSimulationResult | null,
  baseline: FlightSimulationResult | null,
  field: 'carryYds' | 'offlineYds',
) => {
  const conditionedValue = conditioned?.[field]
  const baselineValue = baseline?.[field]
  return finite(conditionedValue) && finite(baselineValue) ? conditionedValue - baselineValue : null
}

export const buildFlightPhysicsPrior = (
  launch: FlightLaunchInput | null,
  environment: FlightEnvironmentInput,
): FlightPhysicsPrior => {
  if (!launch) {
    return {
      modelVersion: 'looper-flight-physics-v1',
      sourceModel: 'OpenFairway-derived-aerodynamics',
      status: 'unavailable',
      launch: null,
      baseline: null,
      windOnly: null,
      elevationOnly: null,
      combined: null,
      deltas: {
        windCarryYds: null,
        windLateralYds: null,
        elevationCarryYds: null,
        combinedCarryYds: null,
        combinedLateralYds: null,
      },
      notes: ['Ball speed, vertical launch angle, and total spin are required for the physics prior.'],
    }
  }

  const baseline = simulateFlight(launch, {})
  const windOnly = simulateFlight(launch, {
    windMph: environment.windMph ?? 0,
    windRelativeDeg: environment.windRelativeDeg ?? 0,
    temperatureF: environment.temperatureF,
    airAltitudeFt: environment.airAltitudeFt,
  })
  const elevationOnly = simulateFlight(launch, {
    landingElevationDeltaFt: environment.landingElevationDeltaFt ?? 0,
    temperatureF: environment.temperatureF,
    airAltitudeFt: environment.airAltitudeFt,
  })
  const combined = simulateFlight(launch, environment)

  return {
    modelVersion: 'looper-flight-physics-v1',
    sourceModel: 'OpenFairway-derived-aerodynamics',
    status: baseline.ok ? 'ready' : 'unavailable',
    launch,
    baseline,
    windOnly,
    elevationOnly,
    combined,
    deltas: {
      windCarryYds: resultDelta(windOnly, baseline, 'carryYds'),
      windLateralYds: resultDelta(windOnly, baseline, 'offlineYds'),
      elevationCarryYds: resultDelta(elevationOnly, baseline, 'carryYds'),
      combinedCarryYds: resultDelta(combined, baseline, 'carryYds'),
      combinedLateralYds: resultDelta(combined, baseline, 'offlineYds'),
    },
    notes: [
      'The physics prior produces condition deltas; Looper does not replace the player Stock carry with the simulator absolute carry.',
      'Wind is applied using air-relative velocity. Elevation uses the descending trajectory intersection with the candidate landing elevation.',
      'No physics-prior delta is allowed into recommendations until the GSPro calibration layer is validated.',
    ],
  }
}

export const windRelativeDegreesForCase = (
  direction: 'head' | 'tail' | 'left-cross' | 'right-cross' | 'head-left' | 'head-right' | 'tail-left' | 'tail-right',
) => {
  switch (direction) {
    case 'head': return 0
    case 'head-right': return 45
    case 'right-cross': return 90
    case 'tail-right': return 135
    case 'tail': return 180
    case 'tail-left': return 225
    case 'left-cross': return 270
    case 'head-left': return 315
  }
}

export const runFlightPhysicsSanityChecks = () => {
  const reference: FlightLaunchInput = {
    ballSpeedMph: 118,
    vlaDeg: 18,
    hlaDeg: 0,
    totalSpinRpm: 5800,
    spinAxisDeg: 0,
  }
  const baseline = simulateFlight(reference, {})
  const head = simulateFlight(reference, { windMph: 10, windRelativeDeg: 0 })
  const tail = simulateFlight(reference, { windMph: 10, windRelativeDeg: 180 })
  const fromRight = simulateFlight(reference, { windMph: 10, windRelativeDeg: 90 })
  const uphill = simulateFlight(reference, { landingElevationDeltaFt: 20 })
  const downhill = simulateFlight(reference, { landingElevationDeltaFt: -20 })
  const baselineCarry = baseline.carryYds ?? Number.NaN
  return [
    { id: 'baseline', label: 'Reference trajectory lands', pass: baseline.ok, value: baseline.carryYds },
    { id: 'headwind', label: 'Headwind reduces carry', pass: (head.carryYds ?? Infinity) < baselineCarry, value: resultDelta(head, baseline, 'carryYds') },
    { id: 'tailwind', label: 'Tailwind increases carry', pass: (tail.carryYds ?? -Infinity) > baselineCarry, value: resultDelta(tail, baseline, 'carryYds') },
    { id: 'crosswind', label: 'Wind from right moves landing left', pass: (fromRight.offlineYds ?? Infinity) < 0, value: fromRight.offlineYds },
    { id: 'uphill', label: 'Higher landing elevation reduces carry', pass: (uphill.carryYds ?? Infinity) < baselineCarry, value: resultDelta(uphill, baseline, 'carryYds') },
    { id: 'downhill', label: 'Lower landing elevation increases carry', pass: (downhill.carryYds ?? -Infinity) > baselineCarry, value: resultDelta(downhill, baseline, 'carryYds') },
  ] as const
}
