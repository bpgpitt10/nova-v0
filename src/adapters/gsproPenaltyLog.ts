/**
 * GSPro's own lie penalty, read from output_log.txt.
 *
 * Every shot from a penalty lie is logged like this (FarmLinks, 2026-10-30):
 *
 *   LaunchExt Vars: sp 76.2, el 27.68, az -14.76, ts 8538.42, sa -4.64, cy 89.77, id 13
 *   LaunchExt - Regular Mode
 *   Penalty Surface TVGdeeprough, Spin53%, Speed 80%, VLA 98%
 *    ... corrected type 3
 *
 * So GSPro names the lie, the exact launch multipliers it applied to that
 * shot, and the currentRound surface code ("type 3"). Looper uses this to
 * learn the penalties from the golfer's real shots (GSPro varies them with
 * launch conditions) and to confirm lie codes without screen reading.
 */
import type { SurfaceLaunchFactors } from '../liveCaddie/surfaceResponse'

export type PenaltyLie = 'rough' | 'deep-rough' | 'sand'

export type GsproPenaltyEvent = Readonly<{
  /** GSPro's name, e.g. "TVGdeeprough". */
  surfaceName: string
  lie: PenaltyLie | null
  speed: number
  spin: number
  vla: number
  /** currentRound surface code GSPro reported for the lie ("corrected type N"). */
  typeCode: number | null
  launch: Readonly<{
    ballSpeedMph: number
    vlaDeg: number
    hlaDeg: number
    spinRpm: number
    spinAxisDeg: number
    launchId: number | null
  }> | null
  /** Stable identity for de-duplication across log re-reads. */
  key: string
}>

const SURFACE_LIES: Record<string, PenaltyLie> = {
  // Seen in a real FarmLinks log. Other names (semi-rough, pine straw) are
  // left unknown until observed.
  tvgrough: 'rough',
  tvgdeeprough: 'deep-rough',
  tvgsand: 'sand',
}

export const lieFromPenaltySurface = (name: string): PenaltyLie | null =>
  SURFACE_LIES[name.trim().toLowerCase()] ?? null

const LAUNCH = /LaunchExt Vars:\s*sp\s*(-?[\d.]+),\s*el\s*(-?[\d.]+),\s*az\s*(-?[\d.]+),\s*ts\s*(-?[\d.]+),\s*sa\s*(-?[\d.]+)(?:,\s*cy\s*(-?[\d.]+))?(?:,\s*id\s*(\d+))?/i
const PENALTY = /Penalty Surface\s+([A-Za-z]+)\s*,\s*Spin\s*(\d+(?:\.\d+)?)%\s*,\s*Speed\s*(\d+(?:\.\d+)?)%\s*,\s*VLA\s*(\d+(?:\.\d+)?)%/i
const TYPE = /corrected type\s+(\d+)/i

export const parseGsproPenaltyEvents = (logText: string): GsproPenaltyEvent[] => {
  const lines = logText.split(/\r?\n/)
  const events: GsproPenaltyEvent[] = []
  let launch: GsproPenaltyEvent['launch'] = null
  let launchLine = -1
  for (let i = 0; i < lines.length; i += 1) {
    const l = LAUNCH.exec(lines[i])
    if (l) {
      launch = {
        ballSpeedMph: Number(l[1]), vlaDeg: Number(l[2]), hlaDeg: Number(l[3]),
        spinRpm: Number(l[4]), spinAxisDeg: Number(l[5]), launchId: l[7] ? Number(l[7]) : null,
      }
      launchLine = i
      continue
    }
    const p = PENALTY.exec(lines[i])
    if (!p) continue
    let typeCode: number | null = null
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
      if (LAUNCH.test(lines[j]) || PENALTY.test(lines[j])) break
      const t = TYPE.exec(lines[j])
      if (t) { typeCode = Number(t[1]); break }
    }
    const pct = (value: string) => Number(value) / 100
    const usedLaunch = launchLine >= 0 && i - launchLine <= 40 ? launch : null
    events.push({
      surfaceName: p[1],
      lie: lieFromPenaltySurface(p[1]),
      spin: pct(p[2]),
      speed: pct(p[3]),
      vla: pct(p[4]),
      typeCode,
      launch: usedLaunch,
      key: [p[1], p[2], p[3], p[4], usedLaunch?.ballSpeedMph, usedLaunch?.vlaDeg, usedLaunch?.spinRpm, usedLaunch?.launchId]
        .join('|'),
    })
  }
  return events
}

// ---- Local learning (this browser only) -----------------------------------

const SAMPLES_KEY = 'looper.gspro-penalty-samples.v1'
const MAX_SAMPLES = 300
const MIN_SAMPLES = 2

type StoredSample = Readonly<{
  key: string
  lie: PenaltyLie
  speed: number
  spin: number
  vla: number
  typeCode: number | null
  seenAt: string
}>

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

export const loadPenaltySamples = (): StoredSample[] => {
  try {
    const raw = storage()?.getItem(SAMPLES_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : []
    return Array.isArray(parsed) ? parsed as StoredSample[] : []
  } catch {
    return []
  }
}

const plausible = (value: number) => Number.isFinite(value) && value >= 0.3 && value <= 1.05

/** Store new penalty events (de-duplicated); returns how many were new. */
export const recordPenaltyEvents = (events: readonly GsproPenaltyEvent[], now = new Date()): number => {
  const store = storage()
  if (!store || events.length === 0) return 0
  const samples = loadPenaltySamples()
  const known = new Set(samples.map((s) => s.key))
  let added = 0
  for (const event of events) {
    if (!event.lie || known.has(event.key)) continue
    if (![event.speed, event.spin, event.vla].every(plausible)) continue
    samples.push({
      key: event.key, lie: event.lie, speed: event.speed, spin: event.spin, vla: event.vla,
      typeCode: event.typeCode, seenAt: now.toISOString(),
    })
    known.add(event.key)
    added += 1
  }
  if (added > 0) {
    try {
      store.setItem(SAMPLES_KEY, JSON.stringify(samples.slice(-MAX_SAMPLES)))
    } catch {
      return 0
    }
  }
  return added
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export type LearnedSurfaceFactors = Partial<Record<PenaltyLie, SurfaceLaunchFactors & { samples: number }>>

/** Median of the golfer's own GSPro penalties per lie (needs 2+ shots). */
export const learnedSurfaceFactors = (samples = loadPenaltySamples()): LearnedSurfaceFactors => {
  const out: LearnedSurfaceFactors = {}
  for (const lie of ['rough', 'deep-rough', 'sand'] as const) {
    const rows = samples.filter((s) => s.lie === lie).slice(-40)
    if (rows.length < MIN_SAMPLES) continue
    out[lie] = {
      speed: median(rows.map((r) => r.speed)),
      spin: median(rows.map((r) => r.spin)),
      vla: median(rows.map((r) => r.vla)),
      samples: rows.length,
    }
  }
  return out
}

/** GSPro's own code -> lie pairs seen in the log ("corrected type 3" after TVGdeeprough). */
export const learnedCodeLies = (samples = loadPenaltySamples()): ReadonlyMap<number, PenaltyLie> => {
  const votes = new Map<number, Map<PenaltyLie, number>>()
  for (const s of samples) {
    if (s.typeCode == null) continue
    const tally = votes.get(s.typeCode) ?? new Map<PenaltyLie, number>()
    tally.set(s.lie, (tally.get(s.lie) ?? 0) + 1)
    votes.set(s.typeCode, tally)
  }
  const out = new Map<number, PenaltyLie>()
  for (const [code, tally] of votes) {
    // Only an unambiguous code: one lie, never contradicted.
    if (tally.size === 1) out.set(code, [...tally.keys()][0])
  }
  return out
}
