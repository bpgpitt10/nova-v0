import { readLooperCompanionCourseLayouts } from '../adapters/looperCompanion'
import {
  getCurrentLooperUser,
  getSupabaseClient,
  isSupabaseConfigured,
} from '../cloud/supabaseClient'
import {
  courseGsproAliases,
  courseRegistry,
  resolveCourseIdFromGsproName,
  type RegisteredCourseId,
} from '../courseGeometry/courseCatalog'
import { loadCourseHoleGeometry } from '../courseGeometry/courseProvider'
import { NativeGkdError, parseGkdLayout } from '../courseGeometry/nativeGkd'
import {
  nativeWorldToHoleLocalYds,
  parseNativeRegistration,
  type NativeRegistration,
} from '../courseGeometry/nativeRegistration'
import type { CourseHoleGeometry, CoursePointYds } from '../courseGeometry/types'
import { courseNameMatchScore } from '../courseLoading/courseNameMatch'

/**
 * Rounds: draw a round's shots on the real hole when the GSPro course is one
 * Looper has loaded. GSPro world positions go through the same registration
 * Live Caddie uses (GSPro scene → the course's LiDAR/OSM frame, tee at the
 * origin), so the shots sit on the same fairways, greens and hazards the
 * caddie plans with.
 *
 * Registration sources, first found wins:
 *   1. the player's account (live_course_info.registration), so any device can draw;
 *   2. the one shipped with the course package (FarmLinks);
 *   3. fitted here from the GSPro course file (companion, sim PC only) and the
 *      course's LiDAR package, then saved to the account.
 */

export type HoleMapContext = {
  courseId: RegisteredCourseId
  registration: NativeRegistration
  source: 'account' | 'package' | 'fitted'
}

export type HoleMapResult =
  | { status: 'ready'; geometry: CourseHoleGeometry; toLocal: (world: { x: number; z: number }) => CoursePointYds | null; source: HoleMapContext['source'] }
  | { status: 'unavailable'; reason: string }

const keyAsName = (key: string) =>
  key.replace(/_gsp$/i, '').replace(/_v\d+$/i, '').replace(/[_-]+/g, ' ')

const packageUrlFor = (courseId: RegisteredCourseId) => {
  const entry = courseRegistry.find((candidate) => candidate.id === courseId)
  return entry && 'staticPackageUrl' in entry ? entry.staticPackageUrl : null
}

/**
 * The loaded Looper course for a GSPro course key ("royal_new_kent_gsp" →
 * Royal New Kent Golf Club). Aliases first; otherwise a clear, unique name
 * match. Only courses with a package can be drawn.
 */
export const loadedCourseIdFor = (courseKey: string, courseName: string | null): RegisteredCourseId | null => {
  const direct = resolveCourseIdFromGsproName(courseKey) ?? (courseName ? resolveCourseIdFromGsproName(courseName) : null)
  if (direct) return packageUrlFor(direct) ? direct : null
  const names = [keyAsName(courseKey), courseName ?? ''].filter(Boolean)
  const scored = courseRegistry
    .filter((entry) => 'staticPackageUrl' in entry && entry.staticPackageUrl)
    .map((entry) => ({
      id: entry.id,
      score: Math.max(0, ...[entry.name, ...courseGsproAliases(entry)].flatMap((label) =>
        names.map((name) => courseNameMatchScore(name, label)))),
    }))
    .sort((a, b) => b.score - a.score)
  const [best, next] = scored
  if (!best || best.score < 0.8) return null
  if (next && next.score >= best.score) return null
  return best.id
}

const sameKey = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

const fetchJson = async (url: string) => {
  const response = await fetch(url, { cache: 'no-cache' }).catch(() => null)
  return response?.ok ? response.json().catch(() => null) : null
}

type InfoRow = { course_id: string | null; registration: unknown }

const accountRegistration = async (courseKey: string, courseId: string) => {
  if (!isSupabaseConfigured()) return null
  const user = await getCurrentLooperUser()
  if (!user) return null
  const client = await getSupabaseClient()
  const result = await client
    .from<InfoRow>('live_course_info')
    .select('course_id,registration')
    .eq('user_id', user.id)
    .eq('course_key', courseKey)
    .maybeSingle()
  if (result.error || !result.data) return null
  const registration = parseNativeRegistration(result.data.registration)
  if (!registration || !sameKey(registration.gsproCourseKey, courseKey) || registration.courseId !== courseId) return null
  return registration
}

const saveAccountRegistration = async (courseKey: string, courseId: string, registration: NativeRegistration) => {
  if (!isSupabaseConfigured()) return
  const user = await getCurrentLooperUser()
  if (!user) return
  const client = await getSupabaseClient()
  // One row, only these columns: the course's name and pars are left as stored.
  const result = await client.from<unknown>('live_course_info').upsert(
    {
      user_id: user.id,
      course_key: courseKey,
      course_id: courseId,
      registration,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,course_key' },
  )
  if (result.error) throw new Error(result.error.message)
}

const packageRegistration = async (courseKey: string, courseId: RegisteredCourseId) => {
  const url = packageUrlFor(courseId)?.replace(/course-v1\.json$/, 'native-registration-v1.json')
  if (!url) return null
  const registration = parseNativeRegistration(await fetchJson(url))
  return registration && sameKey(registration.gsproCourseKey, courseKey) ? registration : null
}

/** Fit GSPro's course to the course's LiDAR terrain, as Live Caddie does on a new course. */
const fittedRegistration = async (courseKey: string, courseId: RegisteredCourseId) => {
  const packageUrl = packageUrlFor(courseId)
  if (!packageUrl) return null
  let layouts
  try {
    layouts = await readLooperCompanionCourseLayouts(courseKey, 12000)
  } catch {
    return null // no companion on this device
  }
  if (layouts.status !== 'ready') return null
  const file = layouts.layouts.find((entry) => entry.kind === 'main') ?? layouts.layouts[0]
  if (!file) return null
  let layout
  try {
    layout = parseGkdLayout(file.text)
  } catch (error) {
    if (error instanceof NativeGkdError) return null
    throw error
  }
  const packageJson = await fetchJson(packageUrl.replace(/course-v1\.json$/, 'course-v1-lidar.json'))
  if (!packageJson) return null
  const { fitRegistrationFromPackage } = await import('../courseGeometry/nativeRegistrationAuto')
  const result = await fitRegistrationFromPackage({ courseId, gsproCourseKey: courseKey, layout, packageJson })
  return result.registration ?? null
}

const contexts = new Map<string, Promise<HoleMapContext | null>>()

export const holeMapContext = (courseKey: string, courseName: string | null): Promise<HoleMapContext | null> => {
  const cacheKey = courseKey.toLowerCase()
  const existing = contexts.get(cacheKey)
  if (existing) return existing
  const promise = (async (): Promise<HoleMapContext | null> => {
    const courseId = loadedCourseIdFor(courseKey, courseName)
    if (!courseId) return null
    const fromAccount = await accountRegistration(courseKey, courseId).catch(() => null)
    if (fromAccount) return { courseId, registration: fromAccount, source: 'account' }
    const fromPackage = await packageRegistration(courseKey, courseId).catch(() => null)
    if (fromPackage) return { courseId, registration: fromPackage, source: 'package' }
    const fitted = await fittedRegistration(courseKey, courseId).catch(() => null)
    if (!fitted) return null
    await saveAccountRegistration(courseKey, courseId, fitted).catch((error) => {
      console.warn('[Rounds] could not save the course alignment to the account.', error)
    })
    return { courseId, registration: fitted, source: 'fitted' }
  })()
  contexts.set(cacheKey, promise)
  // A miss (companion closed, network) may succeed on the next visit.
  void promise.then((value) => {
    if (!value) contexts.delete(cacheKey)
  })
  return promise
}

const ON_MAP_MARGIN_YDS = 80

/**
 * The real hole with a GSPro→hole transform, or why it can't be drawn. Shots
 * that would land well off the mapped hole (wrong course, renumbered holes)
 * fall back to the plain drawing rather than a misleading one.
 */
export const loadHoleMap = async (
  courseKey: string | null,
  courseName: string | null,
  holeNumber: number,
  worldPoints: readonly { x: number; z: number }[],
): Promise<HoleMapResult> => {
  if (!courseKey) return { status: 'unavailable', reason: 'no course' }
  const context = await holeMapContext(courseKey, courseName)
  if (!context) return { status: 'unavailable', reason: 'not a loaded course, or not aligned yet' }
  if (!context.registration.holes[String(holeNumber)]) return { status: 'unavailable', reason: 'hole not aligned' }
  let geometry: CourseHoleGeometry
  try {
    geometry = await loadCourseHoleGeometry(context.courseId, holeNumber)
  } catch {
    return { status: 'unavailable', reason: 'hole geometry not available' }
  }
  const toLocal = (world: { x: number; z: number }) =>
    nativeWorldToHoleLocalYds(context.registration, holeNumber, world)
  const bounds = geometry.viewBounds ?? geometry.bounds
  const onMap = worldPoints.every((point) => {
    const local = toLocal(point)
    return local != null
      && local[0] >= bounds.minX - ON_MAP_MARGIN_YDS && local[0] <= bounds.maxX + ON_MAP_MARGIN_YDS
      && local[1] >= bounds.minY - ON_MAP_MARGIN_YDS && local[1] <= bounds.maxY + ON_MAP_MARGIN_YDS
  })
  if (!onMap) return { status: 'unavailable', reason: 'shots fall outside the mapped hole' }
  return { status: 'ready', geometry, toLocal, source: context.source }
}
