/**
 * GSPro's currentRound.dat EndingSurface numeric codes are not a validated
 * exhaustive lie vocabulary. Prefer fail-closed to a strong and incorrect
 * launch penalty. Never infer "sand" from raw 3 without corroborating HUD
 * evidence: FarmLinks White H1, Round 255, Shot 1 physically finished in
 * GSPro Deep Rough but Live Caddie displayed SAND/BUNKER (-91.6 yards).
 *
 * The UI can use the imported OSM rough polygon as a *planning fallback*,
 * not as proof that the GSPro lie is ordinary rough instead of Deep Rough.
 */
export const surfaceFromGsproRaw = (value: number | null): string | null => {
  switch (value) {
    case 1: return 'rough'
    case 2: return 'fairway'
    case 5: return 'green'
    case 18: return 'tee'
    // Raw 3 has a documented live conflict with Deep Rough. Formerly 'sand'.
    // Raw 11 likewise had prior conflicts (scrub/bunker).
    case 3:
    case 11:
    default: return null
  }
}
