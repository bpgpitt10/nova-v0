import { generatedImportedCourseRegistry } from './generatedImportedCourseRegistry'
import { gsproLinks } from './gsproLinks'

export const GREYWOLF_COURSE_ID = 'greywolf-panorama-bc' as const
export const UNSELECTED_COURSE_ID = '__no-course-selected__' as const

export type CourseCacheStatus = 'cached' | 'missing' | 'unknown'
export type CoursePackageStatus = 'ready' | 'validation' | 'missing'

export type CourseCatalogEntry = {
  id: string
  name: string
  location: string
  slug: string
  gsproAliases: readonly string[]
  staticPackageUrl?: string
  status: 'validated' | 'validation'
  packageStatus: CoursePackageStatus
  packageVersion: string | null
  packageCacheStatus: CourseCacheStatus
  osmCacheStatus: CourseCacheStatus
  lidarCacheStatus: CourseCacheStatus
  /** Built from the player's GSPro course file alone (no map loaded): gsproOnlyCourse.ts. */
  source?: 'gspro-only'
  /** GSPro's course altitude (feet), when known. */
  altitudeFt?: number | null
}

/**
 * Runtime-supported course registry. Canonical imported courses are generated
 * from runtime-ready receipts; they must never require a hand-added catalog row.
 * Greywolf was the one legacy hand-registered course; since 11/4 it is a
 * loaded course like any other (loaded_courses row, same id, so its round
 * history stays with it). GREYWOLF_COURSE_ID remains for that id and for the
 * dev fixtures built on the old hand-made holes. Augusta National, Arcadia
 * Bluffs and Oakmont were removed (2026-10-30): their packages never produced
 * usable live positions; git history keeps them.
 */
const staticCourseRegistry = [
  ...generatedImportedCourseRegistry,
] as const satisfies readonly CourseCatalogEntry[]

/**
 * Course ids: the built-in courses above, plus courses the one-click loader
 * published at run time (Supabase `loaded_courses`, added by
 * registerRuntimeCourses), so any loaded course's id is a plain string.
 */
export type RegisteredCourseId = string
export type CourseId = RegisteredCourseId | typeof UNSELECTED_COURSE_ID

/** Every playable course: built in, then loaded at run time. Grows in place. */
export const courseRegistry: CourseCatalogEntry[] = [...staticCourseRegistry]

const unselectedCourseEntry = {
  id: UNSELECTED_COURSE_ID,
  name: 'Choose a course',
  location: '—',
  slug: 'no-course-selected',
  gsproAliases: [] as const,
  status: 'validation',
  packageStatus: 'missing',
  packageVersion: null,
  packageCacheStatus: 'missing',
  osmCacheStatus: 'unknown',
  lidarCacheStatus: 'unknown',
} as const satisfies CourseCatalogEntry

/**
 * Runtime/player-facing catalog. The explicit unselected row is a UI state,
 * not a real course and never enters the runtime-supported registry.
 */
export const courseCatalog: CourseCatalogEntry[] = [
  unselectedCourseEntry,
  ...courseRegistry,
]

const runtimeHoleHeadings = new Map<string, readonly (number | null)[]>()
export const COURSES_UPDATED_EVENT = 'looper:courses-updated'

/**
 * Add courses published at run time by the one-click loader. A course built
 * into the site keeps its built-in entry (same id or slug). Returns how many
 * were new.
 */
export const registerRuntimeCourses = (
  entries: ReadonlyArray<CourseCatalogEntry & { holeHeadings?: readonly (number | null)[] | null }>,
): number => {
  let added = 0
  for (const entry of entries) {
    const { holeHeadings, ...course } = entry
    if (holeHeadings?.length) runtimeHoleHeadings.set(course.id, holeHeadings)
    const existing = courseRegistry.findIndex((candidate) => candidate.id === course.id || candidate.slug === course.slug)
    if (existing >= 0) {
      // A runtime copy may be replaced by a newer load; built-in ones stay.
      if (staticCourseRegistry.some((candidate) => candidate.id === courseRegistry[existing].id)) continue
      courseRegistry[existing] = course
      const inCatalog = courseCatalog.findIndex((candidate) => candidate.id === course.id || candidate.slug === course.slug)
      if (inCatalog >= 0) courseCatalog[inCatalog] = course
      continue
    }
    courseRegistry.push(course)
    courseCatalog.push(course)
    added += 1
  }
  if (added) {
    try {
      window.dispatchEvent(new Event(COURSES_UPDATED_EVENT))
    } catch {
      // not in a browser (tests)
    }
  }
  return added
}

/** Hole headings worked out on this device (GSPro-only courses, from the course file). */
export const setRuntimeHoleHeadings = (courseId: string, headings: readonly (number | null)[]) => {
  if (headings.some((h) => typeof h === 'number')) runtimeHoleHeadings.set(courseId, headings)
}

/** True heading of a runtime-loaded course's hole (tee to green), if published. */
export const getRuntimeHoleHeadingDegreesTrue = (courseId: string, holeNumber: number): number | null => {
  const heading = runtimeHoleHeadings.get(courseId)?.[Math.max(1, Math.min(18, Math.round(holeNumber))) - 1]
  return typeof heading === 'number' && Number.isFinite(heading) ? heading : null
}

/** A course's package folder (built in: /course-geometry/<slug>/; loaded: its storage folder). */
export const coursePackageBaseUrl = (slug: string): string => {
  const entry = courseRegistry.find((candidate) => candidate.slug === slug)
  const url = entry?.staticPackageUrl
  return url ? url.replace(/[^/]*$/, '') : `/course-geometry/${encodeURIComponent(slug)}/`
}

export const getCourseCatalogEntry = (courseId: CourseId): CourseCatalogEntry & { id: CourseId } => {
  if (courseId === UNSELECTED_COURSE_ID) return unselectedCourseEntry
  const entry = courseRegistry.find((candidate) => candidate.id === courseId)
  if (!entry) throw new Error(`Unknown Looper course id: ${courseId}`)
  return entry
}

export const isCourseId = (value: string | null | undefined): value is CourseId =>
  value === UNSELECTED_COURSE_ID ||
  (value != null && courseRegistry.some((entry) => entry.id === value))

const normalizeCourseName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Course identity is explicit data, not fuzzy name equality at shot time.
 * Deliberately renamed GSPro courses can add a reviewed alias to the course
 * build config; canonical imports carry those aliases into the generated
 * registry automatically.
 */
export const resolveCourseIdFromGsproName = (
  gsproName: string,
  options: Readonly<{ includeGsproOnly?: boolean }> = {},
): RegisteredCourseId | null => {
  const normalized = normalizeCourseName(gsproName)
  if (!normalized) return null

  // A loaded map beats the GSPro-only entry for the same course.
  for (const entry of courseRegistry) {
    if (entry.source === 'gspro-only') continue
    if (entry.gsproAliases.some((alias) => normalizeCourseName(alias) === normalized)) {
      return entry.id
    }
  }
  // Links players made on the Load page ("DPC Pebble" → Pebble Beach).
  for (const link of gsproLinks()) {
    if (normalizeCourseName(link.gsproCourseKey) !== normalized
      && normalizeCourseName(link.gsproCourseName ?? '') !== normalized) continue
    const entry = courseRegistry.find((candidate) => candidate.slug === link.courseSlug)
    if (entry) return entry.id
  }
  if (options.includeGsproOnly !== false) {
    for (const entry of courseRegistry) {
      if (entry.source !== 'gspro-only') continue
      if (entry.gsproAliases.some((alias) => normalizeCourseName(alias) === normalized)) return entry.id
    }
  }
  return null
}

/** Reviewed aliases plus GSPro courses players linked to this course. */
export const courseGsproAliases = (entry: Readonly<{ slug: string; gsproAliases: readonly string[] }>): string[] => [
  ...entry.gsproAliases,
  ...gsproLinks().filter((link) => link.courseSlug === entry.slug).map((link) => link.gsproCourseKey),
]
