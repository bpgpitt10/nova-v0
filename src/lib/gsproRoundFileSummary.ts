// What GSPro's currentRound.dat and output_log.txt looked like, reduced to the
// few facts Live Caddie's round-following depends on. Pure: no I/O, no shot
// data beyond ids and counters, so it is safe to show under Details and to
// store as a diagnostic.

type Rec = Record<string, unknown>

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null
const isRec = (value: unknown): value is Rec =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const hole = (record: Rec) => {
  const raw = num(record.Hole)
  return raw == null ? null : Math.round(raw) + 1
}
export const shortId = (id: string | null | undefined) => (id ? id.slice(-4) : '-')

export type GsproRoundFileSummary = {
  bytes: number
  rootKeys: string[]
  currentShot: {
    roundId: number | null
    hole: number | null
    holeShot: number | null
    courseKey: string | null
    surface: number | null
  } | null
  /** One entry per RoundID, in the order each first appears in the file. */
  rounds: Array<{
    roundId: number | null
    courseKey: string | null
    shots: number
    maxGlobal: number | null
    maxHole: number | null
    lastIndex: number
  }>
  /** The last records in file order. */
  tail: Array<{ roundId: number | null; hole: number | null; holeShot: number | null; global: number | null; id: string }>
  parseError: string | null
}

export const summarizeGsproRoundFile = (text: string | null): GsproRoundFileSummary | null => {
  if (text == null) return null
  const summary: GsproRoundFileSummary = {
    bytes: text.length, rootKeys: [], currentShot: null, rounds: [], tail: [], parseError: null,
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    summary.parseError = error instanceof Error ? error.message.slice(0, 80) : 'not JSON'
    return summary
  }
  const records: Rec[] = []
  if (Array.isArray(parsed)) {
    summary.rootKeys = ['[array]']
    parsed.forEach((item) => { if (isRec(item)) records.push(item) })
  } else if (isRec(parsed)) {
    summary.rootKeys = Object.keys(parsed).slice(0, 12)
    const current = parsed.CurrentShot ?? parsed.currentShot
    if (isRec(current)) {
      summary.currentShot = {
        roundId: num(current.RoundID),
        hole: hole(current),
        holeShot: num(current.HoleShot),
        courseKey: str(current.CourseKey),
        surface: num(current.StartingSurface),
      }
    }
    Object.values(parsed).forEach((value) => {
      if (Array.isArray(value)) value.forEach((item) => { if (isRec(item)) records.push(item) })
    })
  }
  const byRound = new Map<string, GsproRoundFileSummary['rounds'][number]>()
  records.forEach((record, index) => {
    if (!str(record.ShotID)) return
    const roundId = num(record.RoundID)
    const key = String(roundId)
    let entry = byRound.get(key)
    if (!entry) {
      entry = { roundId, courseKey: str(record.CourseKey), shots: 0, maxGlobal: null, maxHole: null, lastIndex: index }
      byRound.set(key, entry)
    }
    entry.shots += 1
    entry.lastIndex = index
    const global = num(record.GlobalShotNumber)
    if (global != null && (entry.maxGlobal == null || global > entry.maxGlobal)) entry.maxGlobal = global
    const h = hole(record)
    if (h != null && (entry.maxHole == null || h > entry.maxHole)) entry.maxHole = h
  })
  summary.rounds = [...byRound.values()].slice(-8)
  summary.tail = records.filter((record) => str(record.ShotID)).slice(-4).map((record) => ({
    roundId: num(record.RoundID),
    hole: hole(record),
    holeShot: num(record.HoleShot),
    global: num(record.GlobalShotNumber),
    id: shortId(str(record.ShotID)),
  }))
  return summary
}

export type GsproOutputLogHoleSummary = {
  markers: number
  lastHoles: number[]
  holedOutAfterLastMarker: boolean
}

export const summarizeOutputLogHoles = (tail: string | null): GsproOutputLogHoleSummary | null => {
  if (tail == null) return null
  const matches = [...tail.matchAll(/currentHole\s*:\s*(-?\d+)/gi)]
  const lastIndex = matches.length ? matches[matches.length - 1].index ?? -1 : -1
  const holedOut = [...tail.matchAll(/AllPlayersHoledOut\s*:\s*1\b/gi)]
  const lastHoledOut = holedOut.length ? holedOut[holedOut.length - 1].index ?? -1 : -1
  return {
    markers: matches.length,
    lastHoles: matches.slice(-5).map((match) => Number(match[1]) + 1),
    holedOutAfterLastMarker: matches.length > 0 && lastHoledOut > lastIndex,
  }
}

/** One line for the Details panel: short enough to read off a screenshot. */
export const roundFileSummaryLine = (
  file: GsproRoundFileSummary | null,
  log: GsproOutputLogHoleSummary | null,
) => {
  if (!file) return 'file: not read'
  if (file.parseError) return `file: unreadable (${file.parseError})`
  const cur = file.currentShot
    ? `cur r${file.currentShot.roundId ?? '?'}/h${file.currentShot.hole ?? '?'}/s${file.currentShot.holeShot ?? '?'}`
    : 'cur none'
  const rounds = file.rounds.length
    ? file.rounds.map((round) => `r${round.roundId ?? '?'}x${round.shots}g${round.maxGlobal ?? '-'}`).join(' ')
    : 'no shots'
  const last = file.tail.length ? file.tail[file.tail.length - 1] : null
  const lastText = last ? `last r${last.roundId ?? '?'}/h${last.hole ?? '?'}/s${last.holeShot ?? '?'}/${last.id}` : 'last none'
  const logText = log
    ? `log h${log.lastHoles.length ? log.lastHoles[log.lastHoles.length - 1] : '-'}${log.holedOutAfterLastMarker ? '+out' : ''}(${log.markers})`
    : 'log none'
  return `${cur} | ${rounds} | ${lastText} | ${logText}`
}
