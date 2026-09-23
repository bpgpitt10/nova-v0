import {
  GREYWOLF_COURSE_ID,
  type CourseId,
} from './courseCatalog'
import type {
  CoursePointYds,
  CourseTeeCandidate,
} from './types'

const GREYWOLF_TEE_START_BASE = '/course-geometry/greywolf/tee-starts'

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const parsePoint = (value: unknown): CoursePointYds | null =>
  Array.isArray(value) && value.length >= 2 && finite(value[0]) && finite(value[1])
    ? [value[0], value[1]]
    : null

const parseWorldPoint = (value: unknown) => {
  const raw = record(value)
  return finite(raw.x) && finite(raw.y) && finite(raw.z)
    ? { x: raw.x, y: raw.y, z: raw.z }
    : null
}

const parseTeeStart = (value: unknown): CourseTeeCandidate | null => {
  const raw = record(value)
  const teeSet = text(raw.teeSet)
  const coursePoint = parsePoint(raw.coursePoint)
  if (!teeSet || !coursePoint) return null
  const gsproWorld = parseWorldPoint(raw.gsproWorld)

  return {
    source: 'gspro-gkd',
    teeSet,
    label: teeSet,
    coursePoint,
    ...(gsproWorld ? { gsproWorld } : {}),
    ...(typeof raw.osmId === 'string' || typeof raw.osmId === 'number'
      ? { osmId: raw.osmId }
      : {}),
  }
}

export const loadGsproTeeStarts = async (
  courseId: CourseId,
  holeNumber: number,
): Promise<readonly CourseTeeCandidate[]> => {
  if (courseId !== GREYWOLF_COURSE_ID) return []

  const response = await fetch(
    `${GREYWOLF_TEE_START_BASE}/greywolf-hole-${String(holeNumber).padStart(2, '0')}.json`,
    { cache: 'force-cache' },
  )
  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`Greywolf Hole ${holeNumber} GSPro tee starts returned ${response.status}.`)
  }

  const payload = record(await response.json())
  const tees = Array.isArray(payload.tees) ? payload.tees : []
  return tees.flatMap((value): CourseTeeCandidate[] => {
    const parsed = parseTeeStart(value)
    return parsed ? [parsed] : []
  })
}
