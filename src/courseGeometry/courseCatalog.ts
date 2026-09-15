export const GREYWOLF_COURSE_ID = 'greywolf-panorama-bc' as const
export const TOBACCO_ROAD_COURSE_ID = 'tobacco-road-sanford-nc' as const

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

export const courseCatalog = [
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
    id: TOBACCO_ROAD_COURSE_ID,
    name: 'Tobacco Road Golf Club',
    location: 'Sanford, NC',
    slug: 'tobacco-road',
    gsproAliases: [
      'Tobacco Road',
      'Tobacco Road Golf Club',
      'Tobacco_Road_gsp',
      'tobacco_road_gsp',
    ],
    staticPackageUrl: '/course-geometry/tobacco-road/course-v1.json',
    status: 'validation',
    packageStatus: 'validation',
    packageVersion: 'v1',
    packageCacheStatus: 'cached',
    osmCacheStatus: 'cached',
    lidarCacheStatus: 'unknown',
  },
] as const satisfies readonly CourseCatalogEntry[]

export type CourseId = (typeof courseCatalog)[number]['id']

export const getCourseCatalogEntry = (courseId: CourseId): CourseCatalogEntry & { id: CourseId } => {
  const entry = courseCatalog.find((candidate) => candidate.id === courseId)
  if (!entry) throw new Error(`Unknown Looper course id: ${courseId}`)
  return entry
}

export const isCourseId = (value: string | null | undefined): value is CourseId =>
  value != null && courseCatalog.some((entry) => entry.id === value)

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
export const resolveCourseIdFromGsproName = (gsproName: string): CourseId | null => {
  const normalized = normalizeCourseName(gsproName)
  if (!normalized) return null

  for (const entry of courseCatalog) {
    if (entry.gsproAliases.some((alias) => normalizeCourseName(alias) === normalized)) {
      return entry.id
    }
  }
  return null
}
