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
 * Runtime-supported course registry. Only courses that have passed the current
 * importer/playability validation belong here. Historical importer artifacts
 * may remain in artifacts/ without becoming selectable runtime courses.
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
  {
    id: 'augusta-national-augusta-ga',
    name: 'Augusta National Golf Club',
    location: 'Augusta, GA',
    slug: 'augusta-national',
    gsproAliases: ['Augusta National', 'Augusta National Golf Club'],
    staticPackageUrl: '/course-geometry/augusta-national/course-v1.json',
    status: 'validated',
    packageStatus: 'ready',
    packageVersion: 'v1',
    packageCacheStatus: 'cached',
    osmCacheStatus: 'cached',
    lidarCacheStatus: 'cached',
  },
  {
    id: 'arcadia-bluffs-arcadia-mi',
    name: 'Arcadia Bluffs — The Bluffs Course',
    location: 'Arcadia, MI',
    slug: 'arcadia-bluffs',
    gsproAliases: [
      'Arcadia Bluffs',
      'Arcadia Bluffs - The Bluffs Course',
      'Arcadia Bluffs — The Bluffs Course',
      'Arcadia Bluffs The Bluffs Course',
    ],
    staticPackageUrl: '/course-geometry/arcadia-bluffs/course-v1.json',
    status: 'validation',
    packageStatus: 'validation',
    packageVersion: 'v1',
    packageCacheStatus: 'cached',
    osmCacheStatus: 'cached',
    lidarCacheStatus: 'cached',
  },
  {
    id: 'oakmont-country-club-oakmont-pa',
    name: 'Oakmont Country Club',
    location: 'Oakmont, PA',
    slug: 'oakmont-country-club',
    gsproAliases: ['Oakmont', 'Oakmont Country Club'],
    staticPackageUrl: '/course-geometry/oakmont-country-club/course-v1.json',
    status: 'validated',
    packageStatus: 'ready',
    packageVersion: 'v1',
    packageCacheStatus: 'cached',
    osmCacheStatus: 'cached',
    lidarCacheStatus: 'cached',
  },
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
 * Deliberately renamed GSPro courses can add a reviewed alias here once the
 * real-world mapping is proven. Location/geometry-assisted discovery belongs
 * in the package-generation workflow, not this deterministic runtime resolver.
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
