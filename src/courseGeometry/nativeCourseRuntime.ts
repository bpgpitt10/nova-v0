import { readLooperCompanionCourseLayouts, readLooperCompanionCourseLibrary } from '../adapters/looperCompanion'
import { courseGsproAliases, getCourseCatalogEntry, setRuntimeHoleHeadings, type CourseId } from './courseCatalog'
import {
  gsproOnlyCourseKey,
  gsproOnlyHoleHeadings,
  gsproOnlyRegistration,
  isGsproOnlyCourseId,
} from './gsproOnlyCourse'
import { courseNameMatchScore } from '../courseLoading/courseNameMatch'
import {
  findNativeSceneFolder,
  listNativeLayoutFiles,
  nativeLayoutName,
  readNativeSceneLayouts,
  sameNativeLayoutFiles,
  walkNativePath,
  type NativeFolderHandle,
  type NativeLayoutFile,
  type NativeSceneLayout,
} from './nativeCourseFolder'
import {
  NativeGkdError,
  nativeHole,
  parseGkdLayout,
  resolveNativeTee,
  sha256Hex,
  type NativeCourseLayout,
  type NativeXYZ,
} from './nativeGkd'
import { parseNativeRegistration, type NativeRegistration } from './nativeRegistration'
import type { AutoRegistrationResult } from './nativeRegistrationAuto'

/**
 * Native positions (beta): browser runtime.
 *
 * - Off unless the golfer turns it on (Live Caddie toggle, or ?native=1).
 * - Reads the course's GKD from the GSPro course folder the golfer grants
 *   (read-only, stays on this machine), and only activates when its layout
 *   fingerprint matches the published registration for that course.
 * - Anything missing or mismatched => status explains why, and Live Caddie
 *   keeps using its existing positioning.
 */

export const NATIVE_POSITIONS_CHANGED_EVENT = 'looper:native-positions-changed'
const STORAGE_KEY = 'looper.native-positions-beta.v1'
const DB_NAME = 'looper-native-course'
const DB_STORE = 'handles'
const DB_KEY = 'gspro-courses-folder'
const SCENE_CACHE_PREFIX = 'scene:'

type PermissionMode = { mode: 'read' | 'readwrite' }
export type NativeDirectoryHandle = NativeFolderHandle & {
  queryPermission?: (options: PermissionMode) => Promise<PermissionState>
  requestPermission?: (options: PermissionMode) => Promise<PermissionState>
}
type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<NativeDirectoryHandle>
}

export type NativeCourseStatus =
  | Readonly<{ state: 'off' }>
  | Readonly<{ state: 'no-course' }>
  | Readonly<{ state: 'no-registration'; courseName: string }>
  | Readonly<{ state: 'other-course'; courseKey: string; expectedKey: string; grade?: string; courseName?: string }>
  | Readonly<{ state: 'no-folder' }>
  | Readonly<{ state: 'needs-permission' }>
  | Readonly<{ state: 'gkd-not-found'; courseKey: string }>
  | Readonly<{ state: 'layout-mismatch'; courseKey: string }>
  /** No published registration and the in-browser fit did not pass. */
  | Readonly<{ state: 'registration-failed'; courseKey: string; reason: string }>
  | Readonly<{ state: 'registering'; courseKey: string }>
  | Readonly<{ state: 'error'; message: string }>
  | Readonly<{
      state: 'ready'
      courseKey: string
      grade: string
      courseName: string
      layoutNames: readonly string[]
      /** Where the layout files came from. */
      via: 'companion' | 'folder'
      /** Registration fitted on this PC (no published one yet). */
      fittedHere?: boolean
      /** Fit numbers when fitted on this load ("fit 0.07 m, halves 2.1 m"). */
      fitDetail?: string
      /** Placed from GSPro's course file alone (no map loaded): gsproOnlyCourse.ts. */
      gsproOnly?: boolean
    }>

export type NativeLayoutOption = Readonly<{ name: string; kind: 'main' | 'alt'; layout: NativeCourseLayout }>

export type NativeCourseContext = Readonly<{
  courseId: CourseId
  /** The GSPro scene key (main GKD file stem) the registration is for. */
  courseKey: string
  /** Active layout. */
  layout: NativeCourseLayout
  layoutName: string
  /** False while a course with several layouts (GKD + GKDalt) has not yet
   * shown which one is being played; by-name tee placement is then skipped. */
  layoutConfirmed: boolean
  /** Every verified layout of the scene, main first. */
  layouts: readonly NativeLayoutOption[]
  registration: NativeRegistration
}>

/** Cached per GSPro course on this browser only (IndexedDB): where the course
 * folder is under the granted folder, the layout files' size/date stamps, and
 * the parsed layouts. A changed stamp re-reads; a moved folder re-searches. */
type SceneCacheRecord = Readonly<{
  version: 1
  path: readonly string[]
  files: readonly NativeLayoutFile[]
  layouts: readonly NativeSceneLayout[]
  cachedAt: string
}>

type LoadResult = Readonly<{ context: NativeCourseContext | null; status: NativeCourseStatus }>

let lastStatus: NativeCourseStatus = { state: 'off' }
const contextCache = new Map<string, Promise<LoadResult>>()

/** Event detail: the status plus which course it is about (null = all). Live
 * Caddie's poller (GSPro's course) and Round Setup (the course being picked)
 * can load different courses at once; listeners must ignore the other one's,
 * or the status line flips between them. */
export type NativeCourseStatusEvent = NativeCourseStatus & { forCourseId?: CourseId | null }

const announce = (status: NativeCourseStatus, courseId: CourseId | null = null) => {
  lastStatus = status
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<NativeCourseStatusEvent>(NATIVE_POSITIONS_CHANGED_EVENT, {
      detail: { ...status, forCourseId: courseId },
    }))
  }
}

/** True when a status event concerns this course (or every course). */
export const nativeStatusEventIsFor = (event: Event, courseId: CourseId | null) => {
  const target = (event as CustomEvent<NativeCourseStatusEvent>).detail?.forCourseId ?? null
  return target == null || target === courseId
}

export const getNativeCourseStatus = () => lastStatus

export const isNativePositionsSupported = () =>
  typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function'

export const isNativePositionsEnabled = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    // ?native=1 / ?native=0 also remembers the choice, so it survives the
    // app's own navigation (Round Setup -> Live Caddie drops the query).
    const param = new URLSearchParams(window.location.search).get('native')
    if (param === '1' || param === '0') {
      try {
        if (param === '1') window.localStorage.setItem(STORAGE_KEY, '1')
        else window.localStorage.removeItem(STORAGE_KEY)
      } catch {
        // storage blocked: the URL still decides for this page
      }
      return param === '1'
    }
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export const invalidateNativeCourseContext = () => {
  contextCache.clear()
}

export const setNativePositionsEnabled = (enabled: boolean) => {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, '1')
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage blocked: the toggle still applies for this page via the URL param.
  }
  invalidateNativeCourseContext()
  announce(enabled ? { state: 'no-course' } : { state: 'off' })
}

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE)
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const dbRequest = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

const loadCoursesFolderHandle = async (): Promise<NativeDirectoryHandle | null> => {
  try {
    return (await dbRequest<NativeDirectoryHandle | undefined>('readonly', (s) => s.get(DB_KEY))) ?? null
  } catch {
    return null
  }
}

/** Must be called from a click: asks the golfer for their GSPro course folder. */
export const chooseGsproCoursesFolder = async (): Promise<NativeCourseStatus> => {
  const picker = (window as PickerWindow).showDirectoryPicker
  if (!picker) return { state: 'error', message: 'This browser cannot open local folders. Use Chrome or Edge on Windows.' }
  const handle = await picker({ id: 'looper-gspro-courses', mode: 'read' })
  await dbRequest('readwrite', (s) => s.put(handle, DB_KEY))
  invalidateNativeCourseContext()
  announce({ state: 'no-course' })
  return lastStatus
}

/** Must be called from a click: re-grants read access after a browser restart. */
export const regrantGsproCoursesFolder = async () => {
  const handle = await loadCoursesFolderHandle()
  if (handle?.requestPermission) await handle.requestPermission({ mode: 'read' })
  invalidateNativeCourseContext()
  announce({ state: 'no-course' })
}

const registrationUrl = (courseId: CourseId) => {
  const packageUrl = getCourseCatalogEntry(courseId).staticPackageUrl
  return packageUrl ? packageUrl.replace(/course-v1\.json$/, 'native-registration-v1.json') : null
}

const loadSceneCache = async (sceneKey: string): Promise<SceneCacheRecord | null> => {
  try {
    const record = await dbRequest<SceneCacheRecord | undefined>('readonly', (st) => st.get(`${SCENE_CACHE_PREFIX}${sceneKey.toLowerCase()}`))
    return record?.version === 1 ? record : null
  } catch {
    return null
  }
}

const saveSceneCache = async (sceneKey: string, record: SceneCacheRecord) => {
  try {
    await dbRequest('readwrite', (st) => st.put(record, `${SCENE_CACHE_PREFIX}${sceneKey.toLowerCase()}`))
  } catch {
    // cache is an optimisation only
  }
}

/** Locate and parse the scene's layouts, reusing this browser's cache when the files are unchanged. */
const readSceneLayouts = async (folder: NativeDirectoryHandle, sceneKey: string) => {
  const cached = await loadSceneCache(sceneKey)
  if (cached) {
    const dir = await walkNativePath(folder, cached.path)
    const files = dir ? await listNativeLayoutFiles(dir) : null
    if (dir && files && sameNativeLayoutFiles(files, cached.files)) return cached.layouts
    if (dir && files) {
      const layouts = await readNativeSceneLayouts(dir, sceneKey, files)
      if (layouts.length > 0) {
        await saveSceneCache(sceneKey, { ...cached, files, layouts, cachedAt: new Date().toISOString() })
        return layouts
      }
    }
  }
  const found = await findNativeSceneFolder(folder, sceneKey)
  if (!found) return null
  const files = await listNativeLayoutFiles(found.dir)
  const layouts = await readNativeSceneLayouts(found.dir, sceneKey, files)
  if (layouts.length > 0) {
    await saveSceneCache(sceneKey, { version: 1, path: found.path, files, layouts, cachedAt: new Date().toISOString() })
  }
  return layouts
}

/** Layouts that belong to the registered scene: same pins and green centres
 * (or, for registrations published before scene fingerprints, the exact main layout). */
export const verifyNativeLayouts = async (
  layouts: readonly NativeSceneLayout[],
  registration: NativeRegistration,
): Promise<readonly NativeLayoutOption[]> => {
  const out: NativeLayoutOption[] = []
  for (const entry of layouts) {
    const ok = registration.sceneFingerprint
      ? (await sha256Hex(entry.layout.sceneFingerprintText)) === registration.sceneFingerprint
      : entry.file.kind === 'main' && (await sha256Hex(entry.layout.fingerprintText)) === registration.layoutFingerprint
    if (ok) out.push({ name: nativeLayoutName(entry), kind: entry.file.kind, layout: entry.layout })
  }
  return out
}

/**
 * The Windows Companion reads the course files from the GSPro library itself.
 * null = no companion (or an older one without the route): use the folder grant.
 */
export const companionSceneLayouts = async (sceneKey: string): Promise<readonly NativeSceneLayout[] | null> => {
  let response
  try {
    response = await readLooperCompanionCourseLayouts(sceneKey)
  } catch {
    return null
  }
  if (response.status !== 'ready') return response.status === 'not-found' ? [] : null
  const out: NativeSceneLayout[] = []
  for (const file of response.layouts) {
    try {
      out.push({
        file: { fileName: file.fileName, kind: file.kind, size: file.size, lastModified: file.lastModified },
        layout: parseGkdLayout(file.text),
      })
    } catch (error) {
      if (!(error instanceof NativeGkdError)) throw error
    }
  }
  return out
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

type SceneLookup =
  | Readonly<{ ok: true; sceneLayouts: readonly NativeSceneLayout[]; via: 'companion' | 'folder' }>
  | Readonly<{ ok: false; status: NativeCourseStatus }>

/** The course's GKD/GKDalt layouts: companion first (no folder grant), then the folder grant. */
const findSceneLayouts = async (key: string): Promise<SceneLookup> => {
  let sceneLayouts = await companionSceneLayouts(key)
  let via: 'companion' | 'folder' = 'companion'
  if (!sceneLayouts || sceneLayouts.length === 0) {
    const folder = await loadCoursesFolderHandle()
    if (!folder) {
      return { ok: false, status: sceneLayouts ? { state: 'gkd-not-found', courseKey: key } : { state: 'no-folder' } }
    }
    const permission = folder.queryPermission ? await folder.queryPermission({ mode: 'read' }) : 'granted'
    if (permission !== 'granted') return { ok: false, status: { state: 'needs-permission' } }
    sceneLayouts = await readSceneLayouts(folder, key)
    via = 'folder'
  }
  if (!sceneLayouts || sceneLayouts.length === 0) return { ok: false, status: { state: 'gkd-not-found', courseKey: key } }
  return { ok: true, sceneLayouts, via }
}

const REGISTRATION_CACHE_PREFIX = 'registration:'

const loadCachedRegistration = async (courseId: CourseId, courseKey: string) => {
  try {
    const raw = await dbRequest<unknown>('readonly', (st) => st.get(`${REGISTRATION_CACHE_PREFIX}${courseId}|${courseKey.toLowerCase()}`))
    return parseNativeRegistration(raw)
  } catch {
    return null
  }
}

const saveCachedRegistration = async (courseId: CourseId, courseKey: string, registration: NativeRegistration | null) => {
  try {
    const key = `${REGISTRATION_CACHE_PREFIX}${courseId}|${courseKey.toLowerCase()}`
    if (registration) await dbRequest('readwrite', (st) => st.put(registration, key))
    else await dbRequest('readwrite', (st) => st.delete(key))
  } catch {
    // cache only
  }
}

/**
 * No published registration (e.g. a course just loaded): fit the player's
 * GKD to the course's LiDAR terrain in this browser (about a second), and
 * keep the result on this PC. Needs GSPro's CourseKey, which the live round
 * reports.
 */
/** "ignoring hole numbers: 17 of 18 greens line up (4.1 m); GSPro 1=map 10, 2=11, …" */
const unorderedText = (u: NonNullable<AutoRegistrationResult['unordered']>) => {
  const renumbered = u.holes.filter(([gspro, map]) => gspro !== map)
  return `; ignoring hole numbers: ${u.paired} of ${u.gkdGreens} greens line up (rms ${u.rmsM.toFixed(1)} m,`
    + ` rotate ${u.rotationDeg.toFixed(1)}°, scale ${u.scale.toFixed(3)}${u.mirrored ? ', mirror-image' : ''})`
    + (renumbered.length ? `; GSPro hole = map hole: ${renumbered.map(([a, b]) => `${a}=${b}`).join(', ')}` : '; same numbering')
    + (u.paired < u.gkdGreens ? `; lined up: holes ${holeRanges(u.holes.map(([g]) => g))}` : '')
    + (u.rest ? `; holes ${holeRanges(u.rest.holes)} fit each other at ${u.rest.rmsM.toFixed(1)} m`
      + ` (rotate ${u.rest.rotationDeg.toFixed(1)}°, scale ${u.rest.scale.toFixed(3)})`
      + ` but the map has them ${u.rest.offsetM.toFixed(0)} m ${compass(u.rest.bearingDeg)} of there` : '')
}

const holeRanges = (holes: readonly number[]) => {
  const sorted = [...new Set(holes)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`)
    i = j
  }
  return out.join(',')
}

const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]

const registerInBrowser = async (
  courseId: CourseId,
  courseKey: string,
  sceneLayouts: readonly NativeSceneLayout[],
): Promise<{ registration: NativeRegistration | null; reason: string }> => {
  const main = sceneLayouts.find((l) => l.file.kind === 'main') ?? sceneLayouts[0]
  const packageUrl = getCourseCatalogEntry(courseId).staticPackageUrl
  if (!main || !packageUrl) return { registration: null, reason: 'no course package' }
  const fetchJson = async (url: string) => {
    const response = await fetch(url, { cache: 'no-cache' }).catch(() => null)
    return response?.ok ? response.json().catch(() => null) : null
  }
  // The LiDAR package's 2-yd terrain comes from the 1 m DEM; the older 10-yd
  // terrain is too coarse (FarmLinks: grade C with it, grade A with LiDAR).
  const packageJson = await fetchJson(packageUrl.replace(/course-v1\.json$/, 'course-v1-lidar.json'))
  if (!packageJson) return { registration: null, reason: 'this course has no LiDAR package yet' }
  const { fitRegistrationFromPackage } = await import('./nativeRegistrationAuto')
  const result = await fitRegistrationFromPackage({ courseId, gsproCourseKey: courseKey, layout: main.layout, packageJson })
  if (!result.registration) {
    const g = result.greenSimilarity
    const m = (v: number) => Number.isFinite(v) ? `${v.toFixed(2)} m` : 'n/a'
    // Numbers to diagnose the failure from a screenshot.
    const detail = ` [${courseKey}: ${result.greensChecked} greens`
      + (result.greenCentresReplaced ? ` (${result.greenCentresReplaced} green centres taken from pins)` : '')
      + (g ? `; greens${result.mirrored ? ' (mirrored)' : ''} rotate ${g.rotationDeg.toFixed(2)}°, scale ${g.scale.toFixed(4)}, rms ${g.rmsM.toFixed(1)} m` : '')
      + (!result.mirrored && result.mirroredSimilarity ? `; mirrored rms ${result.mirroredSimilarity.rmsM.toFixed(1)} m` : '')
      + `; height fit ${m(result.fit.medianAbsM)}, halves ${m(result.fit.halvesAgreeM)}, ${result.fit.points} points`
      + (result.holeShift ? `; greens line up if ${result.holeShift.label}`
        + ` (rms ${result.holeShift.rmsM.toFixed(1)} m, rotate ${result.holeShift.rotationDeg.toFixed(1)}°)` : '')
      + (result.unordered ? unorderedText(result.unordered) : '')
      + ']'
    return {
      registration: null,
      reason: (result.fit.grade === 'C'
        ? 'GSPro course does not match the map closely enough'
        : `only ${result.greensWithin25m} of ${result.greensChecked} greens line up; is GSPro on this course?`) + detail,
    }
  }
  if (result.movedHoles.length) {
    return {
      registration: result.registration,
      reason: `holes ${holeRanges(result.movedHoles)} placed on their own (GSPro's scene moved them)`
        + (result.greensOnly ? '; placed from the greens' : ''),
    }
  }
  if (result.greensOnly) {
    const g = result.greenSimilarity
    return {
      registration: result.registration,
      reason: `placed from the greens (${result.greensChecked} greens, ${g ? g.rmsM.toFixed(1) : '?'} m)`
        + `; GSPro's ground heights don't match the map's (height fit ${Number.isFinite(result.fit.medianAbsM) ? result.fit.medianAbsM.toFixed(2) : 'n/a'} m)`,
    }
  }
  const turn = (result.registration.rotationDeg ? `, turned ${result.registration.rotationDeg.toFixed(1)}°` : '')
    + (result.registration.mirrored ? ', mirror-image scene' : '')
    + (result.greenCentresReplaced ? `, ${result.greenCentresReplaced} green centres from pins` : '')
    + (result.usedHazardPoints ? ', with penalty-area outlines' : '')
  return {
    registration: result.registration,
    reason: `fit ${result.fit.medianAbsM.toFixed(2)} m, halves ${result.fit.halvesAgreeM.toFixed(1)} m${turn}`,
  }
}

const keyAsName = (key: string) => key.replace(/_gsp$/i, '').replace(/[_-]+/g, ' ')

/** The installed GSPro course for a Looper course, by name ("Valhalla" in
 * GSPro vs "Valhalla Golf Club" here). Only a clear, unique best match counts. */
export const pickInstalledCourseKey = (
  names: readonly string[],
  courses: readonly Readonly<{ courseKey: string; courseName: string }>[],
): string | null => {
  const scored = courses.map((course) => ({
    key: course.courseKey,
    score: Math.max(0, ...names.flatMap((name) => [
      courseNameMatchScore(name, course.courseName),
      courseNameMatchScore(name, keyAsName(course.courseKey)),
    ])),
  })).sort((a, b) => b.score - a.score)
  const [best, next] = scored
  if (!best || best.score < 0.8) return null
  if (next && next.score >= best.score) return null
  return best.key
}

/** Every installed course that matches the name equally well (best first),
 * e.g. two Valhalla installs. The map fit decides between them. */
export const installedCourseCandidates = (
  names: readonly string[],
  courses: readonly Readonly<{ courseKey: string; courseName: string }>[],
  limit = 4,
): string[] => {
  const scored = courses.map((course) => ({
    key: course.courseKey,
    score: Math.max(0, ...names.flatMap((name) => [
      courseNameMatchScore(name, course.courseName),
      courseNameMatchScore(name, keyAsName(course.courseKey)),
    ])),
  })).filter((c) => c.score >= 0.8).sort((a, b) => b.score - a.score)
  const top = scored[0]?.score ?? 0
  const keys: string[] = []
  for (const c of scored) {
    if (c.score < top - 0.05 || keys.length >= limit) break
    if (!keys.some((k) => sameName(k, c.key))) keys.push(c.key)
  }
  return keys
}

const installedCourseKeysFor = async (courseId: CourseId): Promise<string[]> => {
  const entry = getCourseCatalogEntry(courseId)
  const library = await readLooperCompanionCourseLibrary().catch(() => null)
  return installedCourseCandidates([entry.name, ...courseGsproAliases(entry)], library?.courses ?? [])
}

/**
 * A GSPro-only course (no map loaded): the registration comes from GSPro's
 * course file itself, with no fit and no published file. Every layout of the
 * scene is usable.
 */
const loadGsproOnlyContext = async (courseId: CourseId, courseKey: string | null): Promise<LoadResult> => {
  const entry = getCourseCatalogEntry(courseId)
  const key = gsproOnlyCourseKey(courseId)!
  const lookup = await findSceneLayouts(key)
  if (!lookup.ok) return { context: null, status: lookup.status }
  const layouts: NativeLayoutOption[] = lookup.sceneLayouts
    .map((scene) => ({ name: nativeLayoutName(scene), kind: scene.file.kind, layout: scene.layout }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1))
  const main = layouts[0]
  const registration = gsproOnlyRegistration({
    courseId,
    courseKey: key,
    layout: main.layout,
    layoutFingerprint: await sha256Hex(main.layout.fingerprintText),
    sceneFingerprint: await sha256Hex(main.layout.sceneFingerprintText),
    altitudeFt: entry.altitudeFt ?? null,
  })
  setRuntimeHoleHeadings(courseId, gsproOnlyHoleHeadings(registration))
  // GSPro's CourseKey may name one of the scene's GKDalt layouts.
  const named = courseKey && !sameName(courseKey, key)
    ? layouts.find((l) => l.kind === 'alt' && sameName(l.name, courseKey)) ?? null
    : null
  if (courseKey && !sameName(courseKey, key) && !named) {
    return { context: null, status: { state: 'other-course', courseKey, expectedKey: key } }
  }
  const active = named ?? main
  return {
    context: {
      courseId,
      courseKey: key,
      layout: active.layout,
      layoutName: active.name,
      layoutConfirmed: Boolean(named) || layouts.length === 1,
      layouts,
      registration,
    },
    status: {
      state: 'ready', courseKey: key, grade: registration.grade, courseName: entry.name,
      layoutNames: layouts.map((l) => l.name), via: lookup.via, gsproOnly: true,
    },
  }
}

const loadContext = async (courseId: CourseId, courseKey: string | null): Promise<LoadResult> => {
  if (isGsproOnlyCourseId(courseId)) return loadGsproOnlyContext(courseId, courseKey)
  const entry = getCourseCatalogEntry(courseId)
  const url = registrationUrl(courseId)
  const response = url ? await fetch(url, { cache: 'no-cache' }).catch(() => null) : null
  let registration = response?.ok ? parseNativeRegistration(await response.json().catch(() => null)) : null
  let fitted = false
  let fitDetail: string | undefined
  // Not in GSPro yet (Round Setup): find the course in the companion's library
  // by name, so GSPro's tee sets can be offered before the round starts.
  // GSPro's course key comes from currentRound.dat, which still names the last
  // course played until a round starts (FarmLinks while setting up Valhalla).
  // A key that is clearly another course must not be fitted to this map: use
  // this course's installed key, and report that GSPro is elsewhere.
  let gsproElsewhere: string | null = null
  let candidates: string[] = []
  if (!registration) {
    const installed = await installedCourseKeysFor(courseId)
    const gsproKeyIsThisCourse = courseKey != null && (installed.length === 0
      || installed.some((k) => sameName(k, courseKey!))
      || installedCourseCandidates([entry.name, ...courseGsproAliases(entry)], [{ courseKey, courseName: keyAsName(courseKey) }]).length > 0)
    if (courseKey && gsproKeyIsThisCourse) candidates = [courseKey]
    else {
      if (courseKey) gsproElsewhere = courseKey
      candidates = installed
    }
    if (candidates.length === 0) return { context: null, status: { state: 'no-registration', courseName: entry.name } }
  }
  let found: Readonly<{ key: string; sceneLayouts: readonly NativeSceneLayout[]; via: 'companion' | 'folder' }> | null = null
  if (registration) {
    const lookup = await findSceneLayouts(registration.gsproCourseKey)
    if (!lookup.ok) return { context: null, status: lookup.status }
    found = { key: registration.gsproCourseKey, sceneLayouts: lookup.sceneLayouts, via: lookup.via }
  } else {
    // Several installs with the same name (two Valhallas): the one whose
    // greens fit the map wins. Report the first failure if none does.
    let failure: NativeCourseStatus | null = null
    for (const candidate of candidates) {
      const lookup = await findSceneLayouts(candidate)
      if (!lookup.ok) { failure ??= lookup.status; continue }
      const cached = await loadCachedRegistration(courseId, candidate)
      if (cached) {
        registration = cached
      } else {
        announce({ state: 'registering', courseKey: candidate }, courseId)
        const result = await registerInBrowser(courseId, candidate, lookup.sceneLayouts)
        if (!result.registration) {
          if (!failure || failure.state !== 'registration-failed') {
            failure = { state: 'registration-failed', courseKey: candidate, reason: result.reason }
          }
          continue
        }
        registration = result.registration
        fitted = true
        fitDetail = result.reason + (candidates.length > 1 ? ` (picked from ${candidates.join(', ')})` : '')
        await saveCachedRegistration(courseId, candidate, registration)
      }
      found = { key: candidate, sceneLayouts: lookup.sceneLayouts, via: lookup.via }
      courseKey = candidate
      break
    }
    if (!found || !registration) {
      return { context: null, status: failure ?? { state: 'no-registration', courseName: entry.name } }
    }
  }
  const { key, sceneLayouts, via } = found
  const layouts = await verifyNativeLayouts(sceneLayouts, registration)
  if (layouts.length === 0) {
    // A course update can change the greens; a locally fitted registration is
    // then refitted on the next load.
    if (!response?.ok && courseKey) await saveCachedRegistration(courseId, courseKey, null)
    return { context: null, status: { state: 'layout-mismatch', courseKey: key } }
  }
  // GSPro's CourseKey is the scene key for the main layout. If it names one of
  // the scene's GKDalt layouts instead, that layout is the one in play.
  const named = courseKey && !sameName(courseKey, key)
    ? layouts.find((l) => l.kind === 'alt' && sameName(l.name, courseKey)) ?? null
    : null
  if (courseKey && !sameName(courseKey, key) && !named) {
    return { context: null, status: { state: 'other-course', courseKey, expectedKey: key } }
  }
  if (gsproElsewhere) {
    return { context: null, status: { state: 'other-course', courseKey: gsproElsewhere, expectedKey: key,
      grade: registration.grade, courseName: entry.name } }
  }
  const active = named ?? layouts.find((l) => l.kind === 'main') ?? layouts[0]
  return {
    context: {
      courseId,
      courseKey: key,
      layout: active.layout,
      layoutName: active.name,
      layoutConfirmed: Boolean(named) || layouts.length === 1,
      layouts,
      registration,
    },
    status: {
      state: 'ready', courseKey: key, grade: registration.grade, courseName: entry.name,
      layoutNames: layouts.map((l) => l.name), via, fittedHere: fitted, ...(fitDetail ? { fitDetail } : {}),
    },
  }
}

/** Round tee-set values for an alternate layout read "White (Farmlinks Kids)". */
export const nativeTeeSetValue = (teeName: string, layout: NativeLayoutOption) =>
  layout.kind === 'alt' ? `${teeName} (${layout.name})` : teeName

/**
 * Which layout is being played. Evidence, strongest first: GSPro's CourseKey
 * naming a GKDalt (already applied at load), the round's tee pick
 * ("White (Farmlinks Kids)"), the layout learned earlier this round, and the
 * pre-shot StartingPOS sitting on a tee of exactly one layout.
 */
export const selectNativeLayout = (
  context: NativeCourseContext,
  inputs: Readonly<{
    holeNumber: number
    preShotWorld: NativeXYZ | null
    normalizedTeeSet: string | null
    rememberedLayoutName: string | null
  }>,
): Readonly<{ context: NativeCourseContext; normalizedTeeSet: string | null; learnedLayoutName: string | null }> => {
  const choose = (option: NativeLayoutOption, confirmed: boolean) =>
    ({ ...context, layout: option.layout, layoutName: option.name, layoutConfirmed: confirmed })
  let teeSet = inputs.normalizedTeeSet
  const suffix = teeSet?.match(/^(.*?)\s*\(([^()]+)\)\s*$/)
  const picked = suffix ? context.layouts.find((l) => sameName(l.name, suffix[2])) ?? null : null
  if (picked && suffix) teeSet = suffix[1]
  if (context.layoutConfirmed || context.layouts.length <= 1) {
    return { context, normalizedTeeSet: teeSet, learnedLayoutName: null }
  }
  if (picked) return { context: choose(picked, true), normalizedTeeSet: teeSet, learnedLayoutName: picked.name }
  // Round Setup lists alternate-layout tees as "White (Farmlinks Kids)", so a
  // plain GSPro tee name ("White") picked there means the main layout.
  const main = context.layouts.find((l) => l.kind === 'main') ?? null
  const plainName = teeSet && !suffix ? teeSet.replace(/\s+/g, '').toLowerCase() : null
  const mainHole = main ? nativeHole(main.layout, inputs.holeNumber) : null
  if (main && plainName && mainHole
    && Object.keys(mainHole.tees).some((name) => name.toLowerCase() === plainName)) {
    return { context: choose(main, true), normalizedTeeSet: teeSet, learnedLayoutName: main.name }
  }
  if (inputs.preShotWorld) {
    const on = context.layouts.filter((l) => {
      const hole = nativeHole(l.layout, inputs.holeNumber)
      return hole ? resolveNativeTee(hole, inputs.preShotWorld!).status !== 'no-match' : false
    })
    if (on.length === 1) return { context: choose(on[0], true), normalizedTeeSet: teeSet, learnedLayoutName: on[0].name }
  }
  const remembered = inputs.rememberedLayoutName
    ? context.layouts.find((l) => sameName(l.name, inputs.rememberedLayoutName!)) ?? null
    : null
  if (remembered) return { context: choose(remembered, true), normalizedTeeSet: teeSet, learnedLayoutName: null }
  return { context, normalizedTeeSet: teeSet, learnedLayoutName: null }
}

/** Status-reporting load; cached per course and GSPro course key. */
export const loadNativeCourseContext = (courseId: CourseId | null, courseKey: string | null): Promise<LoadResult> => {
  // A GSPro-only course has no other positioning: it is always native.
  if (!isNativePositionsEnabled() && !isGsproOnlyCourseId(courseId)) {
    if (lastStatus.state !== 'off') announce({ state: 'off' })
    return Promise.resolve({ context: null, status: { state: 'off' } })
  }
  if (!courseId) {
    announce({ state: 'no-course' })
    return Promise.resolve({ context: null, status: { state: 'no-course' } })
  }
  const cacheKey = `${courseId}|${courseKey ?? ''}`
  let pending = contextCache.get(cacheKey)
  if (!pending) {
    pending = loadContext(courseId, courseKey).catch((error: unknown) => ({
      context: null,
      status: { state: 'error', message: error instanceof Error ? error.message : String(error) } as const,
    }))
    contextCache.set(cacheKey, pending)
    void pending.then((result) => {
      // Retry soon if the folder or permission may change; keep successes.
      if (!result.context) window.setTimeout(() => contextCache.delete(cacheKey), 5000)
    })
  }
  return pending.then((result) => {
    if (JSON.stringify(result.status) !== JSON.stringify(lastStatus)) announce(result.status, courseId)
    return result
  })
}

/** Live-path helper: the context when native positions are on and verified, else null. */
export const nativeCourseContextForLive = async (
  courseId: CourseId | null,
  courseKey: string | null,
): Promise<NativeCourseContext | null> => (await loadNativeCourseContext(courseId, courseKey)).context

// Pin slot for each hole of the active GSPro round, learned from GSPro's own
// distance to pin. Per hole: on Royal New Kent the slot learned on one hole put
// the next hole's pin at the front when GSPro had it at the back (11/3).
const pinSlots = new Map<string, number>()
const slotKey = (courseKey: string, roundId: number | null) => `${courseKey}|${roundId ?? 'round'}`
const pinSlotKey = (courseKey: string, roundId: number | null, holeNumber: number) =>
  `${slotKey(courseKey, roundId)}|h${holeNumber}`

export const rememberNativePinSlot = (courseKey: string, roundId: number | null, holeNumber: number, slot: number) => {
  pinSlots.set(pinSlotKey(courseKey, roundId, holeNumber), slot)
  try {
    window.sessionStorage.setItem(`looper.native-pin-slot.${pinSlotKey(courseKey, roundId, holeNumber)}`, String(slot))
  } catch {
    // memory copy is enough
  }
}

export const rememberNativeLayout = (courseKey: string, roundId: number | null, layoutName: string) => {
  try {
    window.sessionStorage.setItem(`looper.native-layout.${slotKey(courseKey, roundId)}`, layoutName)
  } catch {
    // best effort
  }
}

export const recallNativeLayout = (courseKey: string, roundId: number | null): string | null => {
  try {
    return window.sessionStorage.getItem(`looper.native-layout.${slotKey(courseKey, roundId)}`)
  } catch {
    return null
  }
}

export const recallNativePinSlot = (courseKey: string, roundId: number | null, holeNumber: number): number | null => {
  const key = pinSlotKey(courseKey, roundId, holeNumber)
  const cached = pinSlots.get(key)
  if (cached != null) return cached
  try {
    const stored = Number(window.sessionStorage.getItem(`looper.native-pin-slot.${key}`))
    return Number.isInteger(stored) && stored > 0 ? stored : null
  } catch {
    return null
  }
}
