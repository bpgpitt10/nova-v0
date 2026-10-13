import type { ManualLieSurface } from '../liveCaddie/currentShotLie'

const STORAGE_KEY = 'looper.gspro-surface-evidence.v1'
const MAX_SAMPLES = 200

export type GsproSurfaceEvidenceSample = Readonly<{
  shotKey: string
  shotId: string
  courseId: string
  holeNumber: number
  roundId: number
  completedHoleShot: number
  endingSurfaceRaw: number
  gsproHudLabel: ManualLieSurface
  observedAt: string
  source: 'golfer-confirmed-visible-gspro-hud'
}>

const valid = (x: GsproSurfaceEvidenceSample): boolean =>
  typeof x.shotKey === 'string' && x.shotKey.length > 0
  && typeof x.shotId === 'string' && x.shotId.length > 0
  && typeof x.courseId === 'string' && x.courseId.length > 0
  && Number.isInteger(x.holeNumber) && x.holeNumber >= 1 && x.holeNumber <= 18
  && Number.isInteger(x.roundId)
  && Number.isInteger(x.completedHoleShot) && x.completedHoleShot >= 1
  && Number.isInteger(x.endingSurfaceRaw) && x.endingSurfaceRaw >= 0
  && x.endingSurfaceRaw <= 128
  && ['rough','deep-rough','sand','fairway'].includes(x.gsproHudLabel)
  && Number.isFinite(Date.parse(x.observedAt))

/** Local research evidence ONLY, not an approved mapping or cloud upload. */
export const loadGsproSurfaceEvidenceSamples = (): GsproSurfaceEvidenceSample[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const value: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(value)) return []
    return value.filter((row): row is GsproSurfaceEvidenceSample =>
      row != null && typeof row === 'object' && valid(row as GsproSurfaceEvidenceSample)
    )
  } catch { return [] }
}

export const recordGsproSurfaceHudConfirmation = (
  sample: GsproSurfaceEvidenceSample,
): boolean => {
  if (typeof window === 'undefined' || !valid(sample)) return false
  const existing = loadGsproSurfaceEvidenceSamples()
    .filter(row => row.shotKey !== sample.shotKey)
  const next = [...existing, sample].slice(-MAX_SAMPLES)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    return true
  } catch { return false }
}
