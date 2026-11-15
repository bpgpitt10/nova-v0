// Why Live Caddie is (or isn't) following the GSPro round. Kept outside the
// watcher so the Details panel can show it and a stuck round can report itself
// (a new player won't send us files: 11/14, the caddie stayed on the tee).
import { loadGsproDirectoryHandle } from '../adapters/browserGsproAccess'
import {
  roundFileSummaryLine,
  shortId,
  summarizeGsproRoundFile,
  summarizeOutputLogHoles,
  type GsproOutputLogHoleSummary,
  type GsproRoundFileSummary,
} from './gsproRoundFileSummary'

const LOG_TAIL_BYTES = 200_000

export type LiveFollowState = {
  hold: 'off' | 'waiting-baseline' | 'holding'
  baselineId: string | null
  /** GSPro file changes seen during the hold that did not release it. */
  unreleasedReads: number
  /** What the watcher last read from GSPro. */
  gspro: {
    roundId: number | null
    courseKey: string | null
    hole: number | null
    nextShot: number | null
    shotId: string | null
    warnings: number
  } | null
  /** What Live Caddie was last given: Looper's own Hole 1 tee, or GSPro's state. */
  published: 'manual-start' | 'gspro' | null
  /** GSPro reads that arrived while an earlier one was still being placed. */
  overtaken: number
  reads: number
  updatedAt: string | null
}

const state: LiveFollowState = {
  hold: 'off', baselineId: null, unreleasedReads: 0, gspro: null, published: null, overtaken: 0, reads: 0, updatedAt: null,
}
let lastFile: GsproRoundFileSummary | null = null
let lastLog: GsproOutputLogHoleSummary | null = null

export const noteLiveFollow = (patch: Partial<LiveFollowState>) => {
  Object.assign(state, patch, { updatedAt: new Date().toISOString() })
}

export const liveFollowState = (): Readonly<LiveFollowState> => state

const readFile = async (name: string) => {
  const handle = await loadGsproDirectoryHandle().catch(() => null)
  if (!handle) return null
  try {
    return await (await handle.getFileHandle(name)).getFile()
  } catch {
    return null
  }
}

/** Re-read the two GSPro files and keep their summaries for the Details line. */
export const refreshGsproFileSummary = async () => {
  const [roundFile, logFile] = await Promise.all([readFile('currentRound.dat'), readFile('output_log.txt')])
  lastFile = summarizeGsproRoundFile(roundFile ? await roundFile.text().catch(() => null) : null)
  lastLog = summarizeOutputLogHoles(logFile
    ? await logFile.slice(Math.max(0, logFile.size - LOG_TAIL_BYTES)).text().catch(() => null)
    : null)
  return { file: lastFile, log: lastLog }
}

/** The Details line: hold state, what GSPro last said, what the file holds. */
export const liveFollowLine = () => {
  const hold = state.hold === 'holding'
    ? `hold ${shortId(state.baselineId)} x${state.unreleasedReads}`
    : state.hold === 'waiting-baseline' ? 'hold (no baseline)' : 'following'
  const gspro = state.gspro
    ? `gspro r${state.gspro.roundId ?? '?'}/h${state.gspro.hole ?? '?'}/s${state.gspro.nextShot ?? '?'}/${shortId(state.gspro.shotId)}`
    : 'gspro none'
  return `${hold} | ${gspro} | out ${state.published ?? '-'} | reads ${state.reads} q${state.overtaken} | ${roundFileSummaryLine(lastFile, lastLog)}`
}

const reported = new Set<string>()

/** Store a diagnostic row for this account. Never throws; at most once per `onceKey`. */
export const reportLiveFollowDiagnostic = async (reason: string, onceKey: string) => {
  if (reported.has(onceKey)) return
  reported.add(onceKey)
  try {
    const { file, log } = await refreshGsproFileSummary()
    const { writeDiagnosticEventToCloud } = await import('../cloud/cloudPersistence')
    await writeDiagnosticEventToCloud({
      component: 'live-caddie-follow',
      modelVersion: 'follow-diag-v1',
      result: reason,
      reason: liveFollowLine().slice(0, 480),
      courseKey: state.gspro?.courseKey ?? file?.currentShot?.courseKey ?? undefined,
      holeNumber: state.gspro?.hole ?? undefined,
      metadata: { follow: { ...state }, file, log },
    })
  } catch {
    // diagnostics must never disturb the round
  }
}

const DAILY_KEY = 'looper.gspro-file-summary.reported-on'

/** Once a day per browser: what GSPro's round file looks like on this PC. */
export const reportGsproFileSummaryDaily = async () => {
  const today = new Date().toISOString().slice(0, 10)
  try {
    if (window.localStorage.getItem(DAILY_KEY) === today) return
  } catch {
    return
  }
  const { file } = await refreshGsproFileSummary().catch(() => ({ file: null }))
  if (!file) return // not on the GSPro PC, or the companion isn't running
  try {
    window.localStorage.setItem(DAILY_KEY, today)
  } catch {
    // report anyway; at worst it repeats
  }
  await reportLiveFollowDiagnostic('file-summary', `daily:${today}`)
}
