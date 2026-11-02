import {
  parseLatestGsproCourseLayout,
  type GsproCourseLayoutRow,
} from './gsproCourseLayoutPin'

/**
 * GSPro writes the round's course layout (each hole's tee and the day's pin, in
 * world metres) into output_log.txt when a round loads. Before Shot 1 that is
 * the only exact source of the tee-to-pin distance GSPro shows on its HUD
 * ("Shot 1 492.6 YDS"): currentRound.dat has no shot yet, and the minimap ruler
 * is pixel-measured (a couple of pixels is ~5 yd on a par 5).
 */

const METERS_TO_YARDS = 1.0936132983377078

export type GsproRoundLayoutTee = Readonly<{
  holeNumber: number
  /** Horizontal tee -> pin, matching GSPro's DistanceToPin. */
  distanceYds: number
  par: number | null
}>

export const layoutTeeForHole = (
  rows: readonly GsproCourseLayoutRow[] | null | undefined,
  holeNumber: number | null | undefined,
): GsproRoundLayoutTee | null => {
  if (!rows || holeNumber == null || holeNumber < 1 || holeNumber > rows.length) return null
  const row = rows[holeNumber - 1]
  if (!row) return null
  const metres = Math.hypot(row.pinPos.x - row.teePos.x, row.pinPos.z - row.teePos.z)
  if (!Number.isFinite(metres) || metres <= 0) return null
  const par = typeof row.par === 'number' && [3, 4, 5, 6].includes(row.par) ? row.par : null
  return { holeNumber, distanceYds: Math.round(metres * METERS_TO_YARDS * 10) / 10, par }
}

/** Largest gap between the pixel ruler and the layout that still counts as the
 * same tee and pin. Wider than ruler error, far narrower than another course's
 * hole or another tee set. */
export const LAYOUT_RULER_AGREEMENT_YDS = 15

/**
 * Prefer GSPro's exact layout distance when it agrees with the live minimap
 * ruler (proving it is this round's tee and pin, not a stale log entry) and the
 * par matches the Looper course. Otherwise keep the ruler.
 */
export const refineTeeDistanceWithLayout = (
  rulerYds: number,
  layout: GsproRoundLayoutTee | null | undefined,
  holeNumber: number,
  holePar: number | null | undefined,
): Readonly<{ distanceYds: number; source: 'gspro-round-layout' | 'minimap-ruler' }> => {
  if (!layout || layout.holeNumber !== holeNumber) return { distanceYds: rulerYds, source: 'minimap-ruler' }
  if (layout.par != null && holePar != null && layout.par !== holePar) {
    return { distanceYds: rulerYds, source: 'minimap-ruler' }
  }
  if (Math.abs(layout.distanceYds - rulerYds) > LAYOUT_RULER_AGREEMENT_YDS) {
    return { distanceYds: rulerYds, source: 'minimap-ruler' }
  }
  return { distanceYds: layout.distanceYds, source: 'gspro-round-layout' }
}

type SliceableFile = Readonly<{
  size: number
  slice: (start?: number, end?: number) => { text: () => Promise<string> }
}>

const INITIAL_SCAN_BYTES = 8_000_000
const OVERLAP_BYTES = 64_000
const HEAD_BYTES = 256

/**
 * Keeps the latest layout in output_log.txt without re-reading a multi-MB log
 * on every poll: the first call scans the last 8 MB, later calls only the bytes
 * GSPro appended (a new round on the same course appends a new layout with the
 * new pins). A smaller file, or a different first line, is a new GSPro session.
 */
export const createOutputLogLayoutReader = () => {
  let state: { size: number; head: string; rows: GsproCourseLayoutRow[] | null } | null = null
  return async (file: SliceableFile | null): Promise<GsproCourseLayoutRow[] | null> => {
    if (!file) return state?.rows ?? null
    const size = file.size
    if (state && size === state.size) return state.rows
    const head = await file.slice(0, Math.min(HEAD_BYTES, size)).text()
    const fresh = !state || size < state.size || head !== state.head
    const start = fresh ? Math.max(0, size - INITIAL_SCAN_BYTES) : Math.max(0, state!.size - OVERLAP_BYTES)
    const found = parseLatestGsproCourseLayout(await file.slice(start, size).text())
    state = { size, head, rows: found ?? (fresh ? null : state!.rows) }
    return state.rows
  }
}
