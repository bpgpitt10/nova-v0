/**
 * Independent on-screen first-tee evidence from native GSPro HUD OCR.
 * No previous-shot/world/layout record, gray-waypoint scale, or mouse input
 * is required. This only gives a distance and a provisional course match.
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

const generic = new Set([
  'golf club', 'golf course', 'country club', 'club', 'the club',
  'golf', 'links', 'course', 'resort', 'the golf club',
])

const norm = (name: string) => name.toLowerCase()
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim()

export const resolveNativeTeeHudDistance = ({
  hud, courseName, courseAliases, holeNumber,
}: {
  hud: NativeTeeHudDistance | null | undefined
  courseName: string
  courseAliases: readonly string[]
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
    || Math.abs(hud.straightDistanceYds - hud.scorecardYards) > 3
    || typeof hud.courseText !== 'string') return null

  const visible = norm(hud.courseText)
  if (visible.length < 6) return null
  const knownNames = [courseName, ...courseAliases]
  const matches = knownNames.some(name => {
    const trusted = norm(name)
    if (trusted.length < 6 || generic.has(trusted)) return false
    return visible === trusted || visible.startsWith(trusted + ' ')
      || trusted.startsWith(visible + ' ')
  })
  return matches ? hud.straightDistanceYds : null
}
