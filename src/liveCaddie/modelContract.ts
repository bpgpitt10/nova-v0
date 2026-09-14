import type { FlightPhysicsPrior } from './flightPhysics'

export type CaddieModelStatus =
  | 'modeled'
  | 'calibrating'
  | 'review'
  | 'not-modeled'
  | 'unavailable'

export type CaddieModelConfidence = 'high' | 'medium' | 'low' | 'unknown'

export type CaddieModelEffect =
  | 'effective-distance'
  | 'carry-mean'
  | 'carry-dispersion'
  | 'lateral-mean'
  | 'lateral-dispersion'
  | 'aim'
  | 'surface-outcomes'
  | 'outcome-risk'

export type CaddieModelFactor = {
  id: string
  label: string
  category: 'player' | 'course' | 'environment' | 'lie' | 'risk'
  rawDisplay: string
  source: string
  sourceConfidence: CaddieModelConfidence
  transformation: string
  modeledDisplay: string
  affects: readonly CaddieModelEffect[]
  modelVersion: string
  status: CaddieModelStatus
  evidenceBasis: string
  notes?: readonly string[]
}

export type CaddieModelContract = {
  schemaVersion: 'looper-caddie-model-contract-v1'
  generatedAt: string
  factors: readonly CaddieModelFactor[]
}

export type PlayerBaselineInput = {
  club?: string | null
  variant?: string | null
  stockCarryYds?: number | null
  carrySigmaYds?: number | null
  lateralBiasYds?: number | null
  lateralSigmaYds?: number | null
  supportShots?: number | null
  launchBallSpeedMph?: number | null
  launchVlaDeg?: number | null
  launchHlaDeg?: number | null
  launchSpinRpm?: number | null
  launchSpinAxisDeg?: number | null
}

export type ShotContextInput = {
  targetDistanceYds?: number | null
  surface?: string | null
  windMph?: number | null
  windRelativeDeg?: number | null
  elevationDeltaFt?: number | null
  elevationSource?: string | null
  elevationConfidence?: CaddieModelConfidence
  lieUpDownDeg?: number | null
  lieLeftRightDeg?: number | null
  lieSource?: string | null
  lieConfidence?: CaddieModelConfidence
  mishitEvidenceLabel?: string | null
  physicsPrior?: FlightPhysicsPrior | null
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const signed = (value: number, digits = 1) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
const priorDelta = (value: number | null | undefined) => finite(value) ? `${signed(value)} yd prior` : 'prior unavailable'

export const buildCaddieModelContract = (
  baseline: PlayerBaselineInput,
  context: ShotContextInput,
  now = new Date(),
): CaddieModelContract => {
  const factors: CaddieModelFactor[] = []

  if (baseline.club && finite(baseline.stockCarryYds)) {
    factors.push({
      id: 'player-stock',
      label: 'Player Stock shot',
      category: 'player',
      rawDisplay: `${baseline.club}${baseline.variant ? ` · ${baseline.variant}` : ''} · ${baseline.stockCarryYds.toFixed(1)} yd`,
      source: 'Looper historical player profile',
      sourceConfidence: (baseline.supportShots ?? 0) >= 10 ? 'high' : (baseline.supportShots ?? 0) >= 5 ? 'medium' : 'low',
      transformation: 'Baseline carry and 2D normal-shot dispersion define the unadjusted shot distribution.',
      modeledDisplay: `carry ${baseline.stockCarryYds.toFixed(1)} yd · carry σ ${finite(baseline.carrySigmaYds) ? baseline.carrySigmaYds.toFixed(1) : '—'} · lateral bias ${finite(baseline.lateralBiasYds) ? signed(baseline.lateralBiasYds) : '—'} yd · lateral σ ${finite(baseline.lateralSigmaYds) ? baseline.lateralSigmaYds.toFixed(1) : '—'} yd`,
      affects: ['carry-mean', 'carry-dispersion', 'lateral-mean', 'lateral-dispersion'],
      modelVersion: 'player-profile-v1',
      status: 'modeled',
      evidenceBasis: `${baseline.supportShots ?? 0} included Stock shots`,
    })
  } else {
    factors.push({
      id: 'player-stock',
      label: 'Player Stock shot',
      category: 'player',
      rawDisplay: 'No selected player profile',
      source: 'Looper historical player profile',
      sourceConfidence: 'unknown',
      transformation: 'Cannot create a modeled shot distribution without a club profile.',
      modeledDisplay: 'Unavailable',
      affects: ['carry-mean', 'carry-dispersion', 'lateral-mean', 'lateral-dispersion'],
      modelVersion: 'player-profile-v1',
      status: 'unavailable',
      evidenceBasis: 'No usable selected profile',
    })
  }

  const hasLaunchPacket =
    finite(baseline.launchBallSpeedMph) &&
    finite(baseline.launchVlaDeg) &&
    finite(baseline.launchSpinRpm)
  factors.push({
    id: 'player-launch',
    label: 'Representative Stock launch',
    category: 'player',
    rawDisplay: hasLaunchPacket
      ? `${baseline.launchBallSpeedMph!.toFixed(1)} mph · ${baseline.launchVlaDeg!.toFixed(1)}° VLA · ${baseline.launchSpinRpm!.toFixed(0)} rpm · ${finite(baseline.launchSpinAxisDeg) ? `${signed(baseline.launchSpinAxisDeg)}° axis` : 'axis —'}`
      : 'Incomplete launch packet',
    source: 'Same Looper historical Stock profile as carry/dispersion',
    sourceConfidence: hasLaunchPacket
      ? (baseline.supportShots ?? 0) >= 10 ? 'high' : 'medium'
      : 'unknown',
    transformation: 'Feeds the aerodynamic physics prior. Absolute physics carry never replaces measured Stock carry; only condition deltas are considered for calibration.',
    modeledDisplay: context.physicsPrior?.status === 'ready'
      ? `physics baseline ${context.physicsPrior.baseline?.carryYds?.toFixed(1) ?? '—'} yd (diagnostic only)`
      : 'Physics prior unavailable',
    affects: ['carry-mean', 'lateral-mean'],
    modelVersion: 'looper-flight-physics-v1',
    status: hasLaunchPacket ? 'modeled' : 'unavailable',
    evidenceBasis: hasLaunchPacket
      ? 'Launch metrics are produced by the existing player-profile calculation.'
      : 'Ball speed + VLA + total spin are required.',
    notes: ['Physics absolute carry is diagnostic. Looper anchors recommendations to the player’s observed Stock carry.'],
  })

  factors.push({
    id: 'target-distance',
    label: 'Target / landing distance',
    category: 'course',
    rawDisplay: finite(context.targetDistanceYds) ? `${context.targetDistanceYds.toFixed(1)} yd` : 'Unavailable',
    source: 'Course / current shot geometry',
    sourceConfidence: finite(context.targetDistanceYds) ? 'high' : 'unknown',
    transformation: 'Compared with planned carry for club-fit scoring. It does not overwrite the player’s Stock carry.',
    modeledDisplay: finite(context.targetDistanceYds) ? `${context.targetDistanceYds.toFixed(1)} yd required horizontal distance` : 'Unavailable',
    affects: ['effective-distance', 'outcome-risk'],
    modelVersion: 'target-distance-v1',
    status: finite(context.targetDistanceYds) ? 'modeled' : 'unavailable',
    evidenceBasis: 'Deterministic geometric distance',
  })

  const elevationPrior = context.physicsPrior?.deltas.elevationCarryYds
  factors.push({
    id: 'elevation',
    label: 'Elevation to candidate landing',
    category: 'course',
    rawDisplay: finite(context.elevationDeltaFt) ? `${signed(context.elevationDeltaFt)} ft` : 'Unavailable',
    source: context.elevationSource ?? 'LiDAR terrain model',
    sourceConfidence: context.elevationConfidence ?? (finite(context.elevationDeltaFt) ? 'medium' : 'unknown'),
    transformation: finite(elevationPrior)
      ? `The flight prior intersects the descending trajectory with the candidate elevation and predicts ${priorDelta(elevationPrior)}. GSPro calibration is still required before application.`
      : 'Candidate-specific start-to-landing elevation is measured; the flight prior cannot run without a representative launch packet.',
    modeledDisplay: finite(context.elevationDeltaFt)
      ? `${priorDelta(elevationPrior)} · 0.0 yd applied to recommendation`
      : 'Unavailable',
    affects: ['effective-distance', 'carry-mean'],
    modelVersion: 'looper-flight-physics-v1 + gspro-elevation-calibration-v0',
    status: finite(context.elevationDeltaFt) ? 'calibrating' : 'unavailable',
    evidenceBasis: finite(elevationPrior)
      ? 'OpenFairway-derived trajectory prior is available; GSPro residual calibration is pending.'
      : 'Terrain elevation can be measured; trajectory inputs may be incomplete.',
    notes: ['Stock carry remains the player baseline; elevation produces a condition delta rather than rewriting the baseline profile.'],
  })

  const hasWind = finite(context.windMph) && finite(context.windRelativeDeg)
  const windCarryPrior = context.physicsPrior?.deltas.windCarryYds
  const windLateralPrior = context.physicsPrior?.deltas.windLateralYds
  factors.push({
    id: 'wind',
    label: 'Wind',
    category: 'environment',
    rawDisplay: hasWind ? `${context.windMph!.toFixed(1)} mph @ ${context.windRelativeDeg!.toFixed(0)}° relative` : 'Unavailable',
    source: 'Live wind sensor / manual calibration input',
    sourceConfidence: hasWind ? 'medium' : 'unknown',
    transformation: finite(windCarryPrior) && finite(windLateralPrior)
      ? `Air-relative velocity physics predicts ${priorDelta(windCarryPrior)} carry and ${priorDelta(windLateralPrior)} lateral. GSPro residual calibration remains the gate.`
      : 'Wind vector is captured, but the physics prior cannot run without a representative launch packet.',
    modeledDisplay: hasWind
      ? `${priorDelta(windCarryPrior)} carry · ${priorDelta(windLateralPrior)} lateral · 0.0 yd applied`
      : 'Unavailable',
    affects: ['carry-mean', 'carry-dispersion', 'lateral-mean', 'lateral-dispersion'],
    modelVersion: 'looper-flight-physics-v1 + gspro-wind-calibration-v0',
    status: hasWind ? 'calibrating' : 'unavailable',
    evidenceBasis: finite(windCarryPrior)
      ? 'Physics prior is active for review; controlled GSPro shot-injection cases will estimate the residual correction.'
      : 'Controlled GSPro wind-response matrix plus representative launch data are required.',
    notes: ['0° means wind from directly ahead (headwind); 90° means wind from the player’s right.'],
  })

  const surface = context.surface?.trim() || null
  factors.push({
    id: 'surface',
    label: 'Surface / lie type',
    category: 'lie',
    rawDisplay: surface ?? 'Unavailable',
    source: 'GSPro lie state / course geometry',
    sourceConfidence: surface ? 'high' : 'unknown',
    transformation: surface === 'fairway' || surface === 'tee'
      ? 'Recognized as baseline playable surface; no extra flight penalty applied.'
      : 'Surface is recognized, but a validated flight/dispersion modifier is not yet applied.',
    modeledDisplay: surface === 'fairway' || surface === 'tee'
      ? 'Baseline shot distribution'
      : surface
        ? '0% carry / 1.00× dispersion adjustment applied (response pending)'
        : 'Unavailable',
    affects: ['carry-mean', 'carry-dispersion', 'lateral-dispersion'],
    modelVersion: 'gspro-surface-response-v0',
    status: !surface ? 'unavailable' : surface === 'fairway' || surface === 'tee' ? 'modeled' : 'calibrating',
    evidenceBasis: surface === 'fairway' || surface === 'tee'
      ? 'Baseline condition'
      : 'Lie state is observable; numerical shot-response modifier is not yet validated.',
  })

  const hasLie = finite(context.lieUpDownDeg) || finite(context.lieLeftRightDeg)
  factors.push({
    id: 'physical-lie',
    label: 'Physical lie angle',
    category: 'lie',
    rawDisplay: hasLie
      ? `${finite(context.lieUpDownDeg) ? `${signed(context.lieUpDownDeg)}° up/down` : '— up/down'} · ${finite(context.lieLeftRightDeg) ? `${signed(context.lieLeftRightDeg)}° left/right` : '— left/right'}`
      : 'Unavailable',
    source: context.lieSource ?? 'GSPro lie footer / sensor',
    sourceConfidence: context.lieConfidence ?? (hasLie ? 'high' : 'unknown'),
    transformation: 'GSPro lie angles can be measured directly. No validated launch/start-line/carry response is applied yet.',
    modeledDisplay: hasLie ? 'Measurement retained; 0.0 yd flight adjustment applied' : 'Unavailable',
    affects: ['carry-mean', 'lateral-mean', 'carry-dispersion', 'lateral-dispersion'],
    modelVersion: 'gspro-lie-angle-response-v0',
    status: hasLie ? 'calibrating' : 'unavailable',
    evidenceBasis: 'Greywolf GSPro research validates lie-angle measurement, not a numerical ball-flight effect.',
  })

  factors.push({
    id: 'mishit-tail',
    label: 'Mishit / severe-outcome tail',
    category: 'risk',
    rawDisplay: context.mishitEvidenceLabel ?? 'Evidence immature',
    source: 'Looper mishit classifier + all-shot history',
    sourceConfidence: 'low',
    transformation: 'Kept separate from the normal Stock distribution until enough player evidence exists.',
    modeledDisplay: 'Not included in aim score yet',
    affects: ['outcome-risk'],
    modelVersion: 'mishit-tail-v0',
    status: 'review',
    evidenceBasis: 'Player-specific evidence is intentionally not replaced with a generic prior.',
  })

  return {
    schemaVersion: 'looper-caddie-model-contract-v1',
    generatedAt: now.toISOString(),
    factors,
  }
}
