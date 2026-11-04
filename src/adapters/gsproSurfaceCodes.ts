/**
 * GSPro surface code evidence registry — observed/legacy code hypotheses
 * separated from the physics of surface TYPES.
 *
 * A GSPro raw numeric code is NOT necessarily an index in a 0..10 enum.
 * Code 18 has appeared on StartingSurface for a tee, and neither the complete
 * type count nor the full code vocabulary has been independently established.
 * Existing labels may change across game versions or surface contexts.
 *
 * Do NOT extend mappings merely from one screen shot without a paired
 * currentRound EndingSurfaceRaw and observed GSPro HUD lie label. Codes not
 * listed (e.g. semi-rough, pine straw) stay unknown until paired.
 */
export type GsproSurfaceCodeEvidence = Readonly<{
  rawCode: number
  operationalLabel: 'tee' | 'fairway' | 'rough' | 'deep-rough' | 'sand' | 'green' | null
  /** paired-confirmed: currentRound EndingSurface matched GSPro's own minimap
   * lie label for the same shot (and the native ball position agreed). */
  state: 'paired-confirmed' | 'working-assumption' | 'blocked-unverified'
  notes: string
}>

// Paired evidence, FarmLinks Round 269 (2026-10-30): native GSPro positions
// through the LiDAR registration, each EndingSurface checked against the
// golfer's screenshot of GSPro's minimap lie label for the next shot.
export const GSProSurfaceCodeEvidenceLibrary: readonly GsproSurfaceCodeEvidence[] = [
  { rawCode: 1, operationalLabel: 'rough', state: 'paired-confirmed',
    notes: 'R269 H3 shot 4: HUD "Rough" (ball under LiDAR tree canopy, inside mapped rough). Legacy mapping agreed.' },
  { rawCode: 2, operationalLabel: 'fairway', state: 'paired-confirmed',
    notes: 'R269: 4 shots ending on mapped fairway (H1 S1/S2, H2 S1, H3 S5 start); legacy mapping agreed.' },
  { rawCode: 3, operationalLabel: 'deep-rough', state: 'paired-confirmed',
    notes: 'R269 H3 shots 1 and 2: HUD "Deep Rough", ball outside every mapped surface. Previously guessed as sand, which caused the Round 255 -91.6 yd sand penalty.' },
  { rawCode: 5, operationalLabel: 'green', state: 'paired-confirmed',
    notes: 'R269: 3 shots ending on mapped greens (H1 S3, H2 S2, H3 S7).' },
  { rawCode: 11, operationalLabel: 'sand', state: 'paired-confirmed',
    notes: 'R269 H3 shot 6: HUD "Sand", ball inside the mapped greenside bunker. Earlier sandbox/woods reading was wrong.' },
  { rawCode: 18, operationalLabel: 'tee', state: 'paired-confirmed',
    notes: 'StartingSurface on every FarmLinks tee shot (R255, R269), StartingPOS on the GKD tee.' },
] as const

// Not yet paired, so deliberately absent from the library above:
// 12: Brian recalls GSPro showing "Fringe" (Royal New Kent R279 H2, shot 3 ended
// 21 yd from the pin and he chipped next). Rounds labels it fringe; confirm with
// a HUD screenshot before Live Caddie uses it.

export const gsproSurfaceCodeEvidence = (rawCode: number | null): GsproSurfaceCodeEvidence | null =>
  rawCode == null ? null : GSProSurfaceCodeEvidenceLibrary.find(row => row.rawCode === rawCode) ?? null

/** Safely return ONLY recognized operational code hypotheses. Unknown must
 * fall back to current GSPro HUD (verified), OSM rough (provisional), or an
 * explicitly unknown unmodeled lie — never invent a bunker carry penalty. */
export const surfaceFromGsproRaw = (value: number | null): string | null =>
  gsproSurfaceCodeEvidence(value)?.operationalLabel ?? null
