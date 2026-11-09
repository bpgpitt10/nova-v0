/**
 * Confirmed tee and pin positions, shared across players.
 *
 * Written when GSPro's own shot evidence confirms both on a hole: the ball's
 * StartingPOS sits on a GKD tee and GSPro's DistanceToPin names a GKD pin.
 * One row per course, hole, tee set and pin day. The course file on each
 * player's PC stays the first source (exact, needs no round); these rows are
 * the fallback for players whose file Looper can't read, and a cross-check
 * (Brian, 11/9: it costs nothing to hold on to). Positions only: GSPro world
 * metres plus the GKD names, never the course file itself.
 */
import { getAllowedUserRecord, getCurrentLooperUser, getSupabaseClient, isSupabaseConfigured } from '../cloud/supabaseClient'
import type { CourseId } from '../courseGeometry/courseCatalog'
import type { NativeXYZ } from '../courseGeometry/nativeGkd'

export type ConfirmedPosition = Readonly<{
  courseId: CourseId
  courseKey: string
  holeNumber: number
  /** Normalized tee set ('' when the round had none). */
  teeSet: string
  /** Pin day ('' when the round had none). */
  pinDay: string
  layoutFingerprint: string
  teeName: string | null
  teeWorld: NativeXYZ
  pinSlot: number
  pinLabel: string | null
  pinWorld: NativeXYZ
}>

type Row = {
  course_id: string
  course_key: string
  hole_number: number
  tee_set: string
  pin_day: string
  layout_fingerprint: string
  tee_name: string | null
  tee_world: unknown
  pin_slot: number
  pin_label: string | null
  pin_world: unknown
  confirmations?: number
}

const xyz = (value: unknown): NativeXYZ | null => {
  if (!value || typeof value !== 'object') return null
  const { x, y, z } = value as Record<string, unknown>
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' && [x, y, z].every(Number.isFinite)
    ? { x, y, z } : null
}

const fromRow = (row: Row): ConfirmedPosition | null => {
  const teeWorld = xyz(row.tee_world)
  const pinWorld = xyz(row.pin_world)
  if (!teeWorld || !pinWorld || !Number.isInteger(row.hole_number)) return null
  return {
    courseId: row.course_id as CourseId, courseKey: row.course_key, holeNumber: row.hole_number,
    teeSet: row.tee_set ?? '', pinDay: row.pin_day ?? '', layoutFingerprint: row.layout_fingerprint,
    teeName: row.tee_name, teeWorld, pinSlot: row.pin_slot, pinLabel: row.pin_label, pinWorld,
  }
}

const positionKey = (p: Pick<ConfirmedPosition, 'courseId' | 'holeNumber' | 'teeSet' | 'pinDay'>) =>
  `${p.courseId}|${p.holeNumber}|${p.teeSet}|${p.pinDay}`

const recordedThisSession = new Set<string>()

/** Fire-and-forget: one write per course/hole/tee/day per page session. */
export const recordConfirmedPosition = async (position: ConfirmedPosition): Promise<'recorded' | 'skipped' | 'failed'> => {
  const key = positionKey(position)
  if (recordedThisSession.has(key)) return 'skipped'
  recordedThisSession.add(key)
  if (!isSupabaseConfigured()) return 'skipped'
  try {
    const user = await getCurrentLooperUser()
    if (!user || !(await getAllowedUserRecord(user))) return 'skipped'
    const client = await getSupabaseClient()
    const result = await client.from<unknown>('confirmed_positions').upsert(
      {
        course_id: position.courseId, course_key: position.courseKey, hole_number: position.holeNumber,
        tee_set: position.teeSet, pin_day: position.pinDay, layout_fingerprint: position.layoutFingerprint,
        tee_name: position.teeName, tee_world: position.teeWorld,
        pin_slot: position.pinSlot, pin_label: position.pinLabel, pin_world: position.pinWorld,
        confirmed_by: user.id, confirmed_at: new Date().toISOString(),
      },
      { onConflict: 'course_id,hole_number,tee_set,pin_day' },
    )
    if (result.error) {
      recordedThisSession.delete(key)
      return 'failed'
    }
    cache.delete(position.courseId)
    return 'recorded'
  } catch {
    recordedThisSession.delete(key)
    return 'failed'
  }
}

const cache = new Map<string, { at: number; rows: readonly ConfirmedPosition[] }>()
const CACHE_MS = 5 * 60_000

export const loadConfirmedPositions = async (courseId: CourseId): Promise<readonly ConfirmedPosition[]> => {
  const hit = cache.get(courseId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows
  if (!isSupabaseConfigured()) return []
  try {
    const client = await getSupabaseClient()
    const result = await client.from<Row>('confirmed_positions').select('*').eq('course_id', courseId)
    const rows = result.error || !Array.isArray(result.data) ? [] : result.data.map(fromRow).filter((r): r is ConfirmedPosition => r !== null)
    cache.set(courseId, { at: Date.now(), rows })
    return rows
  } catch {
    return []
  }
}

/**
 * The row for this hole, tee and day. Without a pin day, the row counts only
 * when it is the only day confirmed for that tee (the pin differs by day).
 */
export const findConfirmedPosition = (
  rows: readonly ConfirmedPosition[],
  { holeNumber, teeSet, pinDay, layoutFingerprint }: Readonly<{
    holeNumber: number
    teeSet: string | null
    pinDay: string | null
    /** The registration's fingerprint: a row from another course-file version is not used. */
    layoutFingerprint: string | null
  }>,
): ConfirmedPosition | null => {
  const tee = (teeSet ?? '').toLowerCase()
  const onHole = rows.filter((r) => r.holeNumber === holeNumber && r.teeSet.toLowerCase() === tee
    && (layoutFingerprint == null || r.layoutFingerprint === layoutFingerprint))
  if (pinDay) return onHole.find((r) => r.pinDay.toLowerCase() === pinDay.toLowerCase()) ?? null
  return onHole.length === 1 ? onHole[0] : null
}

/**
 * Cross-check when the course file *is* readable: the pin Looper chose
 * against the one a round confirmed for this hole, tee and day. A pin from
 * GSPro's own record needs no check (and will overwrite the row). A pin from
 * the day pick or a remembered slot that disagrees means a wrong day picked
 * in GSPro or in Looper, or a changed course file: say so, change nothing.
 */
export const confirmedPinNote = ({ position, pinSlot, pinFromGsproRecord, pinDay }: Readonly<{
  position: ConfirmedPosition | null
  pinSlot: number | null
  pinFromGsproRecord: boolean
  pinDay: string | null
}>): string | null => {
  if (!position || pinSlot == null || pinFromGsproRecord || position.pinSlot === pinSlot) return null
  const confirmedAs = position.pinLabel ?? `slot ${position.pinSlot}`
  return pinDay
    ? `A round that picked ${position.pinDay || 'this day'} confirmed the ${confirmedAs} pin on this hole; Looper has a different pin for ${pinDay}. Check the pin day picked in GSPro.`
    : `A round confirmed the ${confirmedAs} pin on this hole; Looper's pin differs. Pick the pin day in Start Round to settle it.`
}

