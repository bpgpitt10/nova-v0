from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:80]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# 1) Add a conservative fore/aft lie response alongside the existing sidehill model.
lie_path = 'src/liveCaddie/lieResponse.ts'
replace_once(
    lie_path,
    "export const SIDEHILL_LIE_MODEL_VERSION = 'looper-sidehill-lie-prior-v0.1'\n",
    "import { simulateFlight, type FlightEnvironmentInput, type FlightLaunchInput } from './flightPhysics'\n\n"
    "export const SIDEHILL_LIE_MODEL_VERSION = 'looper-sidehill-lie-prior-v0.1'\n"
    "export const UPDOWN_LIE_MODEL_VERSION = 'looper-updown-lie-prior-v0.1'\n"
    "export const UPDOWN_LIE_GAIN = 0.25\n"
    "export const UPDOWN_LIE_MAX_VLA_DELTA_DEG = 3\n"
    "export const UPDOWN_LIE_MAX_CARRY_FRACTION = 0.03\n",
)

p = Path(lie_path)
text = p.read_text(encoding='utf-8')
append = r'''

export type UpDownLieResponse = {
  status: 'ready' | 'unavailable'
  modelVersion: string
  gain: number
  lieUpDownDeg: number | null
  appliedVlaDeltaDeg: number
  rawCarryDeltaYds: number
  carryCapYds: number
  carryDeltaYds: number
}

type UpDownLieInput = {
  launch: FlightLaunchInput | null
  environment?: FlightEnvironmentInput
  lieUpDownDeg?: number | null
  stockCarryYds?: number | null
}

/**
 * Conservative V0 fore/aft lie prior.
 *
 * GSPro convention:
 *   lieUpDownDeg > 0 = Up, which increases effective launch angle.
 *   lieUpDownDeg < 0 = Down, which decreases effective launch angle.
 *
 * Only 25% of measured slope is applied to VLA, with an absolute ±3° VLA cap.
 * The adjusted launch packet is then run through the same flight model under the
 * current environment. The resulting carry delta is capped to ±3% of measured
 * Stock carry so this unvalidated prior cannot dominate club selection.
 */
export const buildUpDownLieResponse = ({
  launch,
  environment = {},
  lieUpDownDeg,
  stockCarryYds,
}: UpDownLieInput): UpDownLieResponse => {
  const finiteStockCarry = finite(stockCarryYds) && stockCarryYds > 0
    ? stockCarryYds
    : null
  const carryCapYds = finiteStockCarry == null
    ? 0
    : finiteStockCarry * UPDOWN_LIE_MAX_CARRY_FRACTION

  if (!launch || !finite(lieUpDownDeg) || finiteStockCarry == null) {
    return {
      status: 'unavailable',
      modelVersion: UPDOWN_LIE_MODEL_VERSION,
      gain: UPDOWN_LIE_GAIN,
      lieUpDownDeg: finite(lieUpDownDeg) ? lieUpDownDeg : null,
      appliedVlaDeltaDeg: 0,
      rawCarryDeltaYds: 0,
      carryCapYds,
      carryDeltaYds: 0,
    }
  }

  const boundedLieDeg = Math.max(-25, Math.min(25, lieUpDownDeg))
  const appliedVlaDeltaDeg = Math.max(
    -UPDOWN_LIE_MAX_VLA_DELTA_DEG,
    Math.min(UPDOWN_LIE_MAX_VLA_DELTA_DEG, boundedLieDeg * UPDOWN_LIE_GAIN),
  )

  const baseline = simulateFlight(launch, environment)
  const adjusted = simulateFlight({
    ...launch,
    vlaDeg: launch.vlaDeg + appliedVlaDeltaDeg,
  }, environment)

  if (!baseline.ok || !adjusted.ok || !finite(baseline.carryYds) || !finite(adjusted.carryYds)) {
    return {
      status: 'unavailable',
      modelVersion: UPDOWN_LIE_MODEL_VERSION,
      gain: UPDOWN_LIE_GAIN,
      lieUpDownDeg,
      appliedVlaDeltaDeg,
      rawCarryDeltaYds: 0,
      carryCapYds,
      carryDeltaYds: 0,
    }
  }

  const rawCarryDeltaYds = adjusted.carryYds - baseline.carryYds
  const carryDeltaYds = Math.max(-carryCapYds, Math.min(carryCapYds, rawCarryDeltaYds))

  return {
    status: 'ready',
    modelVersion: UPDOWN_LIE_MODEL_VERSION,
    gain: UPDOWN_LIE_GAIN,
    lieUpDownDeg,
    appliedVlaDeltaDeg,
    rawCarryDeltaYds,
    carryCapYds,
    carryDeltaYds,
  }
}
'''
if 'export const buildUpDownLieResponse' in text:
    raise SystemExit('lieResponse.ts: up/down model already present')
p.write_text(text.rstrip() + append + '\n', encoding='utf-8')

# 2) Wire it into canonical shot context after surface launch conditioning.
shot_path = 'src/liveCaddie/shotContextModel.ts'
replace_once(
    shot_path,
    "  buildSidehillLieResponse,\n  type SidehillLieResponse,\n} from './lieResponse'",
    "  buildSidehillLieResponse,\n  buildUpDownLieResponse,\n  type SidehillLieResponse,\n  type UpDownLieResponse,\n} from './lieResponse'",
)
replace_once(
    shot_path,
    "  sidehillLieResponse: SidehillLieResponse\n",
    "  sidehillLieResponse: SidehillLieResponse\n  upDownLieResponse: UpDownLieResponse\n",
)
replace_once(
    shot_path,
    " * Sidehill physical lie uses the existing conservative loft-aware geometric prior\n * at 50% of the raw geometric effect. Up/down lie remains measurement-only until\n * its carry/VLA response is separately validated.\n",
    " * Sidehill physical lie uses the existing conservative loft-aware geometric prior\n * at 50% of the raw geometric effect. Up/down uses a weaker provisional prior:\n * 25% of measured slope is applied to VLA, capped at ±3°, and the resulting carry\n * response is capped at ±3% of measured Stock carry.\n",
)
replace_once(
    shot_path,
    "  const sidehillLieResponse = buildSidehillLieResponse({\n    club: baseline.club,\n    lieLeftRightDeg: context.lieLeftRightDeg,\n    carryYds: preLieCarryYds,\n  })\n\n  const appliedAdjustments = {",
    "  const sidehillLieResponse = buildSidehillLieResponse({\n    club: baseline.club,\n    lieLeftRightDeg: context.lieLeftRightDeg,\n    carryYds: preLieCarryYds,\n  })\n  const upDownLieResponse = buildUpDownLieResponse({\n    launch: surfaceLaunch ?? launch,\n    environment: flightEnvironment,\n    lieUpDownDeg: context.lieUpDownDeg,\n    stockCarryYds: stockCarry,\n  })\n\n  const appliedAdjustments = {",
)
replace_once(
    shot_path,
    "    lieCarryYds: 0,\n",
    "    lieCarryYds: upDownLieResponse.status === 'ready'\n      ? upDownLieResponse.carryDeltaYds\n      : 0,\n",
)
replace_once(
    shot_path,
    "    sidehillLieResponse,\n    // Elevation is already represented",
    "    sidehillLieResponse,\n    upDownLieResponse,\n    // Elevation is already represented",
)

# 3) Make player-facing and diagnostic copy tell the truth about the active prior.
replace_once(
    'src/pages/ConditionsMathPanel.tsx',
    "        upDownLabel ? 'up/down flight effect pending validation' : null,\n",
    "        upDownLabel ? '25% VLA V0 prior · ±3° VLA / ±3% carry caps' : null,\n",
)
replace_once(
    'src/liveCaddie/aimOptimization.ts',
    "  /** Positive = GSPro Up. Retained for later validation; no V0 carry effect is applied. */\n",
    "  /** Positive = GSPro Up. V0 applies a conservative 25% VLA prior with tight caps. */\n",
)
replace_once(
    'src/pages/LiveCaddieWorker.ts',
    "const EVALUATION_CACHE_NAME = 'looper-live-caddie-evaluations-v6'\n",
    "const EVALUATION_CACHE_NAME = 'looper-live-caddie-evaluations-v7'\n",
)

# 4) Update the model contract so diagnostics no longer claim up/down is zero.
contract_path = Path('src/liveCaddie/modelContract.ts')
contract = contract_path.read_text(encoding='utf-8')
contract = contract.replace(
    "import { buildSidehillLieResponse, SIDEHILL_LIE_MODEL_VERSION } from './lieResponse'",
    "import {\n  buildSidehillLieResponse,\n  SIDEHILL_LIE_MODEL_VERSION,\n  UPDOWN_LIE_MODEL_VERSION,\n} from './lieResponse'",
    1,
)
start = contract.find("  const hasLie = finite(context.lieUpDownDeg) || finite(context.lieLeftRightDeg)\n")
end_marker = "\n\n  factors.push({\n    id: 'mishit-tail'"
end = contract.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit('modelContract.ts: physical lie block not found')
new_block = r'''  const hasLie = finite(context.lieUpDownDeg) || finite(context.lieLeftRightDeg)
  const sidehillReference = buildSidehillLieResponse({
    club: baseline.club,
    lieLeftRightDeg: context.lieLeftRightDeg,
    carryYds: baseline.stockCarryYds,
  })
  const sidehillReady = sidehillReference.status === 'ready'
  const upDownReady = finite(context.lieUpDownDeg) && hasLaunchPacket && finite(baseline.stockCarryYds)
  const modeledLieParts = [
    sidehillReady
      ? `${signed(sidehillReference.appliedBiasDeg, 2)}° sidehill center tendency · ${signed(sidehillReference.lateralDeltaYds)} yd lateral on Stock-carry reference`
      : finite(context.lieLeftRightDeg)
        ? 'sidehill measured; model unavailable for this club/carry'
        : null,
    upDownReady
      ? 'up/down carry prior active: 25% of measured slope to VLA · ±3° VLA cap · ±3% Stock-carry cap'
      : finite(context.lieUpDownDeg)
        ? 'up/down measured; representative launch packet unavailable'
        : null,
  ].filter(Boolean).join(' · ')
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
      : 'Sidehill uses loft-aware face geometry with a conservative 50% gain. Up/down uses a weaker 25% VLA perturbation, capped at ±3° VLA and ±3% of measured Stock carry. Both are provisional V0 priors applied before aim/risk optimization.',
    modeledDisplay: !hasLie ? 'Unavailable' : modeledLieParts || 'Measurement retained; model unavailable',
    affects: ['carry-mean', 'lateral-mean', 'aim', 'surface-outcomes', 'outcome-risk'],
    modelVersion: `${SIDEHILL_LIE_MODEL_VERSION} + ${UPDOWN_LIE_MODEL_VERSION}`,
    status: hasLie ? 'calibrating' : 'unavailable',
    evidenceBasis: 'Conservative V0 physical-lie priors. Sidehill is loft/side-slope geometry at 50% gain; fore/aft lie perturbs VLA at 25% gain with tight safety caps until controlled GSPro observations can fit the response.',
    notes: hasLie
      ? [
          'Physical lie changes the modeled distribution before aim/risk optimization; it is not a post-hoc aim instruction.',
          'Up/down keeps ball speed and spin unchanged in V0; only VLA is perturbed, then the existing flight model determines carry direction and magnitude.',
        ]
      : undefined,
  })'''
contract_path.write_text(contract[:start] + new_block + contract[end:], encoding='utf-8')

print('Applied conservative up/down lie prior patch.')
