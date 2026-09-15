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

const plannedCourseDefaults = {
  status: 'validation',
  packageStatus: 'missing',
  packageVersion: null,
  packageCacheStatus: 'missing',
  osmCacheStatus: 'unknown',
  lidarCacheStatus: 'unknown',
} as const

/**
 * Complete internal course registry, including planned pilot courses that do
 * not have runtime packages yet. Build/ingestion tooling should use this list.
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
  {
    id: 'royal-new-kent-providence-forge-va',
    name: 'Royal New Kent Golf Club',
    location: 'Providence Forge, VA',
    slug: 'royal-new-kent',
    gsproAliases: ['Royal New Kent', 'Royal New Kent Golf Club'],
    ...plannedCourseDefaults,
  },
  {
    id: 'arcadia-bluffs-arcadia-mi',
    name: 'Arcadia Bluffs — The Bluffs Course',
    location: 'Arcadia, MI',
    slug: 'arcadia-bluffs',
    gsproAliases: ['Arcadia Bluffs', 'The Bluffs Course', 'Arcadia Bluffs — The Bluffs Course'],
    ...plannedCourseDefaults,
  },
  {
    id: 'shaftesbury-glen-conway-sc',
    name: 'Shaftesbury Glen Golf & Fish Club',
    location: 'Conway, SC',
    slug: 'shaftesbury-glen',
    gsproAliases: ['Shaftesbury Glen', 'Shaftesbury Glen Golf & Fish Club'],
    ...plannedCourseDefaults,
  },
  {
    id: 'valhalla-louisville-ky',
    name: 'Valhalla Golf Club',
    location: 'Louisville, KY',
    slug: 'valhalla',
    gsproAliases: ['Valhalla', 'Valhalla Golf Club'],
    ...plannedCourseDefaults,
  },
  {
    id: 'muirfield-village-dublin-oh',
    name: 'Muirfield Village Golf Club',
    location: 'Dublin, OH',
    slug: 'muirfield-village',
    gsproAliases: ['Muirfield Village', 'Muirfield Village Golf Club'],
    ...plannedCourseDefaults,
  },
  {
    id: 'cabot-cliffs-inverness-ns',
    name: 'Cabot Cliffs',
    location: 'Inverness, NS',
    slug: 'cabot-cliffs',
    gsproAliases: ['Cabot Cliffs'],
    ...plannedCourseDefaults,
  },
  {
    id: 'greywalls-marquette-mi',
    name: 'Greywalls at Marquette Golf Club',
    location: 'Marquette, MI',
    slug: 'greywalls',
    gsproAliases: ['Ashen Cliffs', 'Greywalls', 'Greywalls at Marquette Golf Club'],
    ...plannedCourseDefaults,
  },
  {
    id: 'paynes-valley-hollister-mo',
    name: "Payne's Valley",
    location: 'Hollister, MO',
    slug: 'paynes-valley',
    gsproAliases: ["Payne's Valley", 'Paynes Valley'],
    ...plannedCourseDefaults,
  },
  {
    id: 'pebble-beach-pebble-beach-ca',
    name: 'Pebble Beach Golf Links',
    location: 'Pebble Beach, CA',
    slug: 'pebble-beach',
    gsproAliases: ['DPC Pebble', 'Pebble Beach', 'Pebble Beach Golf Links'],
    ...plannedCourseDefaults,
  },
] as const satisfies readonly CourseCatalogEntry[]

export type CourseId = (typeof courseRegistry)[number]['id']

/**
 * Runtime/player-facing catalog. Planned rows stay internal until a package
 * exists, so registering the pilot queue cannot create dead course choices.
 */
export const courseCatalog = courseRegistry.filter(
  (entry) => entry.packageStatus !== 'missing',
)

export const getCourseCatalogEntry = (courseId: CourseId): CourseCatalogEntry & { id: CourseId } => {
  const entry = courseRegistry.find((candidate) => candidate.id === courseId)
  if (!entry) throw new Error(`Unknown Looper course id: ${courseId}`)
  return entry
}

export const isCourseId = (value: string | null | undefined): value is CourseId =>
  value != null && courseRegistry.some((entry) => entry.id === value)

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

  for (const entry of courseRegistry) {
    if (entry.gsproAliases.some((alias) => normalizeCourseName(alias) === normalized)) {
      return entry.id
    }
  }
  return null
}
