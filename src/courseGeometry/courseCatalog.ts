import { generatedImportedCourseRegistry } from './generatedImportedCourseRegistry'

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
}

/**
 * Runtime-supported course registry. Canonical imported courses are generated
 * from runtime-ready receipts; they must never require a hand-added catalog row.
 * Greywolf is the one legacy hand-registered course. Augusta National, Arcadia
 * Bluffs and Oakmont were removed (2026-10-30): their packages never produced
 * usable live positions; git history keeps them.
 */
export const courseRegistry = [
  {
    id: GREYWOLF_COURSE_ID,
    name: 'Greywolf Golf Course',
    location: 'Panorama, BC',
    slug: 'greywolf',
    gsproAliases: [
      'Greywolf',
      'Greywolf Golf Course',
      'Greywolf_gsp',
      'greywolf_gsp',
    ],
    status: 'validated',
    packageStatus: 'ready',
    packageVersion: 'v1',
    packageCacheStatus: 'cached',
    osmCacheStatus: 'cached',
    lidarCacheStatus: 'cached',
  },
  ...generatedImportedCourseRegistry,
] as const satisfies readonly CourseCatalogEntry[]

export type RegisteredCourseId = (typeof courseRegistry)[number]['id']
export type CourseId = RegisteredCourseId | typeof UNSELECTED_COURSE_ID

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
export const courseCatalog = [
  unselectedCourseEntry,
  ...courseRegistry,
]

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
export const resolveCourseIdFromGsproName = (gsproName: string): RegisteredCourseId | null => {
  const normalized = normalizeCourseName(gsproName)
  if (!normalized) return null

  for (const entry of courseRegistry) {
    if (entry.gsproAliases.some((alias) => normalizeCourseName(alias) === normalized)) {
      return entry.id
    }
  }
  return null
}
