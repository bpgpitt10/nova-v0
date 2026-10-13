/**
 * GSPro surface code evidence registry — observed/legacy code hypotheses
 * separated from the physics of surface TYPES.
 *
 * A GSPro raw numeric code is NOT necessarily an index in a 0..10 enum.
 * Code 18 has appeared on StartingSurface for a tee, and neither the complete
 * type count nor the full code vocabulary has been independently established.
 * Existing labels may change across game versions or surface contexts.
 *
 * A "working-assumption" entry is the pre-existing parser mapping, not proof.
 * Do NOT extend mappings merely from one screen shot without a paired
 * currentRound EndingSurfaceRaw and observed GSPro HUD lie label.
 */
export type GsproSurfaceCodeEvidence = Readonly<{
  rawCode: number
  operationalLabel: 'tee' | 'fairway' | 'rough' | 'green' | null
  state: 'working-assumption' | 'blocked-unverified'
  notes: string
}>

export const GSProSurfaceCodeEvidenceLibrary: readonly GsproSurfaceCodeEvidence[] = [
  { rawCode: 1, operationalLabel: 'rough', state: 'working-assumption',
    notes: 'Legacy currentRound parser mapping; lacks a modern paired HUD-label sample.' },
  { rawCode: 2, operationalLabel: 'fairway', state: 'working-assumption',
    notes: 'Legacy currentRound parser mapping; lacks a modern paired HUD-label sample.' },
  { rawCode: 3, operationalLabel: null, state: 'blocked-unverified',
    notes: 'Previously mapped to sand without adequate independent ground truth. Unsafe to impose bunker launch physics.' },
  { rawCode: 5, operationalLabel: 'green', state: 'working-assumption',
    notes: 'Legacy currentRound parser mapping; confirm with matched current GSPro HUD evidence.' },
  { rawCode: 11, operationalLabel: null, state: 'blocked-unverified',
    notes: 'Conflicting historic sandbox/woods interpretation; refuse guessing.' },
  { rawCode: 18, operationalLabel: 'tee', state: 'working-assumption',
    notes: 'Observed in real FarmLinks StartingSurfaceRaw when playing from tee; stronger, but not a complete codebook.' },
] as const

export const gsproSurfaceCodeEvidence = (rawCode: number | null): GsproSurfaceCodeEvidence | null =>
  rawCode == null ? null : GSProSurfaceCodeEvidenceLibrary.find(row => row.rawCode === rawCode) ?? null

/** Safely return ONLY recognized operational code hypotheses. Unknown must
 * fall back to current GSPro HUD (verified), OSM rough (provisional), or an
 * explicitly unknown unmodeled lie — never invent a bunker carry penalty. */
export const surfaceFromGsproRaw = (value: number | null): string | null =>
  gsproSurfaceCodeEvidence(value)?.operationalLabel ?? null
