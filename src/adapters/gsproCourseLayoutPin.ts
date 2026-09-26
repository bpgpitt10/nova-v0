const METERS_TO_YARDS = 1.0936132983377078

export type GsproCourseLayoutVec3 = {
  x: number
  y: number
  z: number
}

export type GsproCourseLayoutRow = {
  active?: unknown
  strokeIdx?: unknown
  par?: unknown
  teePos: GsproCourseLayoutVec3
  pinPos: GsproCourseLayoutVec3
}

export type GsproCourseLayoutPinMatch = {
  row: GsproCourseLayoutRow
  binding: 'display-hole-array-order' | 'distance-fallback'
  holeNumber: number
  teeToPinDistanceYds: number
  distanceErrorYds: number | null
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const vec3 = (value: unknown): GsproCourseLayoutVec3 | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const x = finite(record.x) ? record.x : null
  const y = finite(record.y) ? record.y : null
  const z = finite(record.z) ? record.z : null
  return x == null || y == null || z == null ? null : { x, y, z }
}

const parseRow = (value: unknown): GsproCourseLayoutRow | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const teePos = vec3(record.teePos)
  const pinPos = vec3(record.pinPos)
  if (!teePos || !pinPos) return null
  return {
    active: record.active,
    strokeIdx: record.strokeIdx,
    par: record.par,
    teePos,
    pinPos,
  }
}

/**
 * GSPro writes the course layout into output_log.txt as a raw JSON array that
 * starts with [{"active"... and is followed by ordinary log text. Extract one
 * balanced JSON array without assuming it occupies the entire line/file.
 */
const balancedJsonArray = (text: string, start: number) => {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }
    if (character === '[' || character === '{') depth += 1
    if (character === ']' || character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

export const parseLatestGsproCourseLayout = (text: string): GsproCourseLayoutRow[] | null => {
  const starts = [...text.matchAll(/\[\s*\{\s*"active"/g)]
  let latest: GsproCourseLayoutRow[] | null = null

  for (const match of starts) {
    if (match.index == null) continue
    const candidateText = balancedJsonArray(text, match.index)
    if (!candidateText) continue
    try {
      const parsed = JSON.parse(candidateText) as unknown
      if (!Array.isArray(parsed)) continue
      const rows = parsed.flatMap((value): GsproCourseLayoutRow[] => {
        const row = parseRow(value)
        return row ? [row] : []
      })
      // Real course layouts normally contain 18 rows. Keep the old Mini Matt
      // acceptance floor so partial/random arrays in the log are rejected.
      if (rows.length >= 9) latest = rows
    } catch {
      // Keep scanning; output_log can contain unrelated JSON fragments.
    }
  }

  return latest
}

export const gsproCourseLayoutTeeToPinDistanceYds = (row: GsproCourseLayoutRow) => {
  const dx = row.pinPos.x - row.teePos.x
  const dy = row.pinPos.y - row.teePos.y
  const dz = row.pinPos.z - row.teePos.z
  return Math.hypot(dx, dy, dz) * METERS_TO_YARDS
}

export const selectGsproCourseLayoutPin = (
  rows: readonly GsproCourseLayoutRow[] | null | undefined,
  holeNumber: number,
  distanceToPinYds: number | null,
  toleranceYds = 4,
): GsproCourseLayoutPinMatch | null => {
  if (!rows || holeNumber < 1 || holeNumber > rows.length) return null

  const indexed = rows[holeNumber - 1]
  if (indexed) {
    const teeToPinDistanceYds = gsproCourseLayoutTeeToPinDistanceYds(indexed)
    const distanceErrorYds = distanceToPinYds == null
      ? null
      : Math.abs(teeToPinDistanceYds - distanceToPinYds)
    if (distanceErrorYds == null || distanceErrorYds <= toleranceYds) {
      return {
        row: indexed,
        binding: 'display-hole-array-order',
        holeNumber,
        teeToPinDistanceYds,
        distanceErrorYds,
      }
    }
  }

  if (distanceToPinYds == null) return null
  const scored = rows.map((row, index) => {
    const teeToPinDistanceYds = gsproCourseLayoutTeeToPinDistanceYds(row)
    return {
      row,
      index,
      teeToPinDistanceYds,
      distanceErrorYds: Math.abs(teeToPinDistanceYds - distanceToPinYds),
    }
  }).sort((a, b) => a.distanceErrorYds - b.distanceErrorYds)

  const best = scored[0]
  const second = scored[1]
  if (!best || best.distanceErrorYds > toleranceYds) return null
  // The old field probe rejected distance-only bindings that were effectively
  // tied. Preserve that guardrail rather than attaching the wrong hole/pin.
  if (second && second.distanceErrorYds - best.distanceErrorYds < 1) return null

  return {
    row: best.row,
    binding: 'distance-fallback',
    holeNumber: best.index + 1,
    teeToPinDistanceYds: best.teeToPinDistanceYds,
    distanceErrorYds: best.distanceErrorYds,
  }
}
