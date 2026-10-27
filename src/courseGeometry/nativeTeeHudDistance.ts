/**
 * Native Shot 1 HUD supplies a distance, never the course identity.
 * The Looper course selector is authoritative for identifying which mapped
 * OSM geometry to compare. GSPro's course-name OCR is a separate, unreliable
 * diagnostic and must not veto a selected course.
 *
 * Read-only, first-tee-only and never authorizes native aim.
 */
export type NativeTeeHudDistance = Readonly<{
  status: string
  source?: string
  courseText?: string
  holeNumber?: number
  shotNumber?: number
  straightDistanceYds?: number
  scorecardYards?: number
  scorecardDifferenceYds?: number
  authorizesNativeAim?: boolean
}>

export const resolveNativeTeeHudDistance = ({
  hud, holeNumber,
}: {
  hud: NativeTeeHudDistance | null | undefined
  holeNumber: number
}): number | null => {
  if (!hud || hud.status !== 'READY'
    || hud.source !== 'gspro-native-shot-hud'
    || hud.authorizesNativeAim !== false
    || hud.shotNumber !== 1 || hud.holeNumber !== holeNumber
    || typeof hud.straightDistanceYds !== 'number'
    || !Number.isFinite(hud.straightDistanceYds)
    || hud.straightDistanceYds < 45 || hud.straightDistanceYds > 750
    || typeof hud.scorecardYards !== 'number'
    || !Number.isFinite(hud.scorecardYards)
    || Math.abs(hud.straightDistanceYds - hud.scorecardYards) > 3) return null

  // No courseText check. Course identity comes from the Looper selector.
  // A unique OSM tee-distance match still must be established by the caller;
  // this measurement is not an exact coordinate or permission to aim/click.
  return hud.straightDistanceYds
}
