from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(rel_path: str, old: str, new: str) -> None:
    path = ROOT / rel_path
    text = path.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{rel_path}: expected exactly one match, found {count}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


# 1) Carry the already-designed lie values through the existing AimLab/Live Caddie environment.
replace_once(
    'src/liveCaddie/aimOptimization.ts',
    """  /** Authoritative current GSPro lie surface. OSM remains the landing-outcome classifier. */
  surfaceOverride?: string | null
  /**
""",
    """  /** Authoritative current GSPro lie surface. OSM remains the landing-outcome classifier. */
  surfaceOverride?: string | null
  /** Positive = GSPro Up. Retained for later validation; no V0 carry effect is applied. */
  lieUpDownDeg?: number | null
  /** Positive = GSPro Left / ball above feet. V0 applies the existing conservative sidehill prior. */
  lieLeftRightDeg?: number | null
  lieSource?: string
  /**
""",
)
replace_once(
    'src/liveCaddie/aimOptimization.ts',
    """    const aimOffsetsYds = buildAimOffsetsYds(profile.lateral_sigma_yds)
    const launch = profile.launch_profile
    const modeled = modelShotContext(
""",
    """    const aimOffsetsYds = buildAimOffsetsYds(profile.lateral_sigma_yds)
    const launch = profile.launch_profile
    const hasLieMeasurement =
      (typeof environment.lieUpDownDeg === 'number' && Number.isFinite(environment.lieUpDownDeg)) ||
      (typeof environment.lieLeftRightDeg === 'number' && Number.isFinite(environment.lieLeftRightDeg))
    const modeled = modelShotContext(
""",
)
replace_once(
    'src/liveCaddie/aimOptimization.ts',
    """        elevationDeltaFt: environment.elevationDeltaFt ?? 0,
        elevationSource: environment.elevationSource ?? 'Aim Lab target terrain',
        elevationConfidence: environment.elevationDeltaFt == null ? 'unknown' : 'medium',
      },
""",
    """        elevationDeltaFt: environment.elevationDeltaFt ?? 0,
        elevationSource: environment.elevationSource ?? 'Aim Lab target terrain',
        elevationConfidence: environment.elevationDeltaFt == null ? 'unknown' : 'medium',
        lieUpDownDeg: environment.lieUpDownDeg ?? null,
        lieLeftRightDeg: environment.lieLeftRightDeg ?? null,
        lieSource: environment.lieSource ?? 'GSPro lie OCR',
        lieConfidence: hasLieMeasurement ? 'high' : 'unknown',
      },
""",
)

# 2) Apply the existing sidehill model at the canonical shot-context boundary.
replace_once(
    'src/liveCaddie/shotContextModel.ts',
    """import { buildFlightPhysicsPrior, type FlightLaunchInput, type FlightPhysicsPrior } from './flightPhysics'
import {
  buildCaddieModelContract,
""",
    """import { buildFlightPhysicsPrior, type FlightLaunchInput, type FlightPhysicsPrior } from './flightPhysics'
import {
  buildSidehillLieResponse,
  type SidehillLieResponse,
} from './lieResponse'
import {
  buildCaddieModelContract,
""",
)
replace_once(
    'src/liveCaddie/shotContextModel.ts',
    """  physicsPrior: FlightPhysicsPrior
  surfaceResponse: SurfaceResponse
  effectiveTargetDistanceYds: number | null
""",
    """  physicsPrior: FlightPhysicsPrior
  surfaceResponse: SurfaceResponse
  sidehillLieResponse: SidehillLieResponse
  effectiveTargetDistanceYds: number | null
""",
)
replace_once(
    'src/liveCaddie/shotContextModel.ts',
    """ * Physical-lie angle response remains blocked until separately validated.
 */
""",
    """ * Sidehill physical lie uses the existing conservative loft-aware geometric prior
 * at 50% of the raw geometric effect. Up/down lie remains measurement-only until
 * its carry/VLA response is separately validated.
 */
""",
)
replace_once(
    'src/liveCaddie/shotContextModel.ts',
    """  const appliedAdjustments = {
""",
    """  // Apply sidehill at the already-conditioned carry distance so the angular
  // tendency becomes the correct lateral-center shift for this particular shot.
  // Up/down lie does not modify carry in V0.
  const preLieCarryYds = stockCarry == null
    ? null
    : stockCarry + combinedAirborneCarryYds + surfaceCarryYds
  const sidehillLieResponse = buildSidehillLieResponse({
    club: baseline.club,
    lieLeftRightDeg: context.lieLeftRightDeg,
    carryYds: preLieCarryYds,
  })

  const appliedAdjustments = {
""",
)
replace_once(
    'src/liveCaddie/shotContextModel.ts',
    """    surfaceCarryYds,
    surfaceLateralYds,
    lieCarryYds: 0,
    lieLateralYds: 0,
  }
""",
    """    surfaceCarryYds,
    surfaceLateralYds,
    lieCarryYds: 0,
    lieLateralYds: sidehillLieResponse.status === 'ready'
      ? sidehillLieResponse.lateralDeltaYds
      : 0,
  }
""",
)
replace_once(
    'src/liveCaddie/shotContextModel.ts',
    """    physicsPrior,
    surfaceResponse,
    // Elevation is already represented by the airborne trajectory delta. Keeping
""",
    """    physicsPrior,
    surfaceResponse,
    sidehillLieResponse,
    // Elevation is already represented by the airborne trajectory delta. Keeping
""",
)

# 3) Keep the inspectable model contract honest about the now-operative sidehill prior.
replace_once(
    'src/liveCaddie/modelContract.ts',
    """import type { FlightPhysicsPrior } from './flightPhysics'
import { getSurfaceResponse } from './surfaceResponse'
""",
    """import type { FlightPhysicsPrior } from './flightPhysics'
import { buildSidehillLieResponse, SIDEHILL_LIE_MODEL_VERSION } from './lieResponse'
import { getSurfaceResponse } from './surfaceResponse'
""",
)
replace_once(
    'src/liveCaddie/modelContract.ts',
    """  const hasLie = finite(context.lieUpDownDeg) || finite(context.lieLeftRightDeg)
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
""",
    """  const hasLie = finite(context.lieUpDownDeg) || finite(context.lieLeftRightDeg)
  const sidehillReference = buildSidehillLieResponse({
    club: baseline.club,
    lieLeftRightDeg: context.lieLeftRightDeg,
    carryYds: baseline.stockCarryYds,
  })
  const sidehillReady = sidehillReference.status === 'ready'
  factors.push({
    id: 'physical-lie',
    label: 'Physical lie angle',
    category: 'lie',
    rawDisplay: hasLie
      ? `${finite(context.lieUpDownDeg) ? `${signed(context.lieUpDownDeg)}° up/down` : '— up/down'} · ${finite(context.lieLeftRightDeg) ? `${signed(context.lieLeftRightDeg)}° left/right` : '— left/right'}`
      : 'Unavailable',
    source: context.lieSource ?? 'GSPro lie footer / sensor',
    sourceConfidence: context.lieConfidence ?? (hasLie ? 'high' : 'unknown'),
    transformation: !hasLie
      ? 'No physical lie angle is available.'
      : sidehillReady
        ? `Sidehill uses loft-aware face geometry with a conservative ${(sidehillReference.gain * 100).toFixed(0)}% gain. Positive GSPro Left moves the modeled shot center left; Right moves it right. Up/down is retained but applies no flight adjustment yet.`
        : 'Lie angle is retained. Sidehill cannot be applied without a supported club/carry; up/down remains measurement-only.',
    modeledDisplay: !hasLie
      ? 'Unavailable'
      : sidehillReady
        ? `${signed(sidehillReference.appliedBiasDeg, 2)}° center tendency · ${signed(sidehillReference.lateralDeltaYds)} yd lateral on Stock-carry reference · 0.0 yd up/down adjustment`
        : 'Measurement retained; 0.0 yd lie adjustment applied',
    affects: ['lateral-mean', 'aim', 'surface-outcomes', 'outcome-risk'],
    modelVersion: SIDEHILL_LIE_MODEL_VERSION,
    status: hasLie ? 'calibrating' : 'unavailable',
    evidenceBasis: sidehillReady
      ? 'Conservative V0 prior from loft/side-slope geometry. The 0.50 gain is intentionally provisional until controlled GSPro validation can fit the coefficient.'
      : 'Lie measurement is retained for later calibration.',
    notes: hasLie
      ? [
          'Sidehill changes the modeled distribution center before aim/risk optimization; it is not a post-hoc aim instruction.',
          'Up/down response remains zero until separately validated.',
        ]
      : undefined,
  })
""",
)

# 4) LIVE Caddie uses fresh READY lie OCR for surface + angles and converts the
# helper's +RIGHT/-LEFT convention exactly once into the sidehill model's
# +LEFT/-RIGHT convention.
replace_once(
    'src/pages/LiveCaddiePage.tsx',
    """  const surface = liveMatchesHole && liveSnapshot?.surface
    ? liveSnapshot.surface
    : hole
      ? classifyPoint(hole, ball).kind
      : 'unknown'
""",
    """  const liveLieSurface = lieObservation?.status === 'READY' && lieObservation.surface?.trim()
    ? lieObservation.surface.trim()
    : null
  const surface = liveLieSurface
    ?? (liveMatchesHole && liveSnapshot?.surface
      ? liveSnapshot.surface
      : hole
        ? classifyPoint(hole, ball).kind
        : 'unknown')
""",
)
replace_once(
    'src/pages/LiveCaddiePage.tsx',
    """  const surfaceOverride = liveMatchesHole ? liveSnapshot?.surface ?? null : null
  const localAimBearingDeg = localShotBearingDegrees(ball, target)
""",
    """  const surfaceOverride = liveLieSurface
    ?? (liveMatchesHole ? liveSnapshot?.surface ?? null : null)
  const localAimBearingDeg = localShotBearingDegrees(ball, target)
""",
)
replace_once(
    'src/pages/LiveCaddiePage.tsx',
    """  const lieUpDownDeg = hasLiveLie
    && typeof lieObservation?.upDownDegrees === 'number'
    && Number.isFinite(lieObservation.upDownDegrees)
    ? lieObservation.upDownDegrees
    : 0
  const lieLeftRightDeg = hasLiveLie
    && typeof lieObservation?.leftRightDegrees === 'number'
    && Number.isFinite(lieObservation.leftRightDegrees)
    ? lieObservation.leftRightDegrees
    : 0
""",
    """  const lieUpDownDeg = hasLiveLie
    && typeof lieObservation?.upDownDegrees === 'number'
    && Number.isFinite(lieObservation.upDownDegrees)
    ? lieObservation.upDownDegrees
    : null
  const lieLeftRightDeg = hasLiveLie
    && typeof lieObservation?.leftRightDegrees === 'number'
    && Number.isFinite(lieObservation.leftRightDegrees)
    // Helper convention is +RIGHT / -LEFT. The existing sidehill model uses
    // +LEFT / -RIGHT, so invert once here at the LIVE Caddie integration seam.
    ? -lieObservation.leftRightDegrees
    : null
  const lieSource = hasLiveLie ? lieObservation?.source ?? 'GSPro lie OCR' : undefined
""",
)
replace_once(
    'src/pages/LiveCaddiePage.tsx',
    """        airAltitudeFt,
        airAltitudeSource,
        surfaceOverride,
      },
""",
    """        airAltitudeFt,
        airAltitudeSource,
        surfaceOverride,
        lieUpDownDeg,
        lieLeftRightDeg,
        lieSource,
      },
""",
)
replace_once(
    'src/pages/LiveCaddiePage.tsx',
    """    airAltitudeFt,
    airAltitudeSource,
    surfaceOverride,
  ])
""",
    """    airAltitudeFt,
    airAltitudeSource,
    surfaceOverride,
    lieUpDownDeg,
    lieLeftRightDeg,
    lieSource,
  ])
""",
)

# 5) Show actual modeled sidehill yards in the condition ledger. Up/down remains measurement-only.
replace_once(
    'src/pages/ConditionsMathPanel.tsx',
    """  const lieDetail = finite(lieUpDownDeg) || finite(lieLeftRightDeg)
    ? 'Measured lie · flight effect not yet modeled'
    : 'Lie angle not captured yet'
  const lieDistance = finite(lieUpDownDeg)
    ? `${lieUpDownDeg >= 0 ? '+' : ''}${lieUpDownDeg.toFixed(1)}°`
    : '—'
  const lieLateral = finite(lieLeftRightDeg)
    ? `${lieLeftRightDeg >= 0 ? '+' : ''}${lieLeftRightDeg.toFixed(1)}°`
    : '—'
""",
    """  const hasLie = finite(lieUpDownDeg) || finite(lieLeftRightDeg)
  const sidehillLabel = finite(lieLeftRightDeg) && Math.abs(lieLeftRightDeg) >= 0.05
    ? `${Math.abs(lieLeftRightDeg).toFixed(1)}° ${lieLeftRightDeg > 0 ? 'Left' : 'Right'}`
    : null
  const upDownLabel = finite(lieUpDownDeg) && Math.abs(lieUpDownDeg) >= 0.05
    ? `${Math.abs(lieUpDownDeg).toFixed(1)}° ${lieUpDownDeg > 0 ? 'Up' : 'Down'}`
    : null
  const lieDetail = hasLie
    ? [
        sidehillLabel,
        upDownLabel,
        sidehillLabel ? '50% loft-aware V0 sidehill prior' : null,
        upDownLabel ? 'up/down flight effect pending validation' : null,
      ].filter(Boolean).join(' · ')
    : 'Lie angle not captured yet'
""",
)
replace_once(
    'src/pages/ConditionsMathPanel.tsx',
    """          <AdjustmentRow
            label=\"Lie\"
            distance={lieDistance}
            lateral={lieLateral}
            detail={lieDetail}
            muted={!finite(lieUpDownDeg) && !finite(lieLeftRightDeg)}
          />
""",
    """          <AdjustmentRow
            label=\"Lie\"
            distance={evaluation && hasLie ? signedYards(evaluation.lieCarryDeltaYds ?? 0) : '—'}
            lateral={evaluation && hasLie ? lateralYards(evaluation.lieLateralDeltaYds ?? 0) : '—'}
            detail={lieDetail}
            muted={!hasLie}
          />
""",
)

# 6) Lie must participate in the worker cache key or a previous recommendation
# could be reused after the player moves onto a different sidehill lie.
replace_once(
    'src/pages/LiveCaddieWorker.ts',
    """const EVALUATION_CACHE_NAME = 'looper-live-caddie-evaluations-v5'
""",
    """const EVALUATION_CACHE_NAME = 'looper-live-caddie-evaluations-v6'
""",
)
replace_once(
    'src/pages/LiveCaddieWorker.ts',
    """      airAltitudeFt: finiteKeyNumber(environment.airAltitudeFt),
      surfaceOverride: environment.surfaceOverride ?? null,
    },
""",
    """      airAltitudeFt: finiteKeyNumber(environment.airAltitudeFt),
      surfaceOverride: environment.surfaceOverride ?? null,
      lieUpDownDeg: finiteKeyNumber(environment.lieUpDownDeg),
      lieLeftRightDeg: finiteKeyNumber(environment.lieLeftRightDeg),
    },
""",
)

print('LIVE Caddie lie integration patch applied successfully.')
