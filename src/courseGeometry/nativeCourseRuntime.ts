import { getCourseCatalogEntry, type CourseId } from './courseCatalog'
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
import { nativeHole, resolveNativeTee, sha256Hex, type NativeCourseLayout, type NativeXYZ } from './nativeGkd'
import { parseNativeRegistration, type NativeRegistration } from './nativeRegistration'

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
  | Readonly<{ state: 'other-course'; courseKey: string; expectedKey: string }>
  | Readonly<{ state: 'no-folder' }>
  | Readonly<{ state: 'needs-permission' }>
  | Readonly<{ state: 'gkd-not-found'; courseKey: string }>
  | Readonly<{ state: 'layout-mismatch'; courseKey: string }>
  | Readonly<{ state: 'error'; message: string }>
  | Readonly<{ state: 'ready'; courseKey: string; grade: string; courseName: string; layoutNames: readonly string[] }>

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

const announce = (status: NativeCourseStatus) => {
  lastStatus = status
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NATIVE_POSITIONS_CHANGED_EVENT, { detail: status }))
  }
}

export const getNativeCourseStatus = () => lastStatus

export const isNativePositionsSupported = () =>
  typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function'

export const isNativePositionsEnabled = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    const param = new URLSearchParams(window.location.search).get('native')
    if (param === '1') return true
    if (param === '0') return false
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

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

const loadContext = async (courseId: CourseId, courseKey: string | null): Promise<LoadResult> => {
  const entry = getCourseCatalogEntry(courseId)
  const url = registrationUrl(courseId)
  const response = url ? await fetch(url, { cache: 'no-cache' }).catch(() => null) : null
  const registration = response?.ok ? parseNativeRegistration(await response.json().catch(() => null)) : null
  if (!registration) return { context: null, status: { state: 'no-registration', courseName: entry.name } }
  const key = registration.gsproCourseKey
  const folder = await loadCoursesFolderHandle()
  if (!folder) return { context: null, status: { state: 'no-folder' } }
  const permission = folder.queryPermission ? await folder.queryPermission({ mode: 'read' }) : 'granted'
  if (permission !== 'granted') return { context: null, status: { state: 'needs-permission' } }
  const sceneLayouts = await readSceneLayouts(folder, key)
  if (!sceneLayouts || sceneLayouts.length === 0) return { context: null, status: { state: 'gkd-not-found', courseKey: key } }
  const layouts = await verifyNativeLayouts(sceneLayouts, registration)
  if (layouts.length === 0) return { context: null, status: { state: 'layout-mismatch', courseKey: key } }
  // GSPro's CourseKey is the scene key for the main layout. If it names one of
  // the scene's GKDalt layouts instead, that layout is the one in play.
  const named = courseKey && !sameName(courseKey, key)
    ? layouts.find((l) => l.kind === 'alt' && sameName(l.name, courseKey)) ?? null
    : null
  if (courseKey && !sameName(courseKey, key) && !named) {
    return { context: null, status: { state: 'other-course', courseKey, expectedKey: key } }
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
    status: { state: 'ready', courseKey: key, grade: registration.grade, courseName: entry.name, layoutNames: layouts.map((l) => l.name) },
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
  if (!isNativePositionsEnabled()) {
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
    if (JSON.stringify(result.status) !== JSON.stringify(lastStatus)) announce(result.status)
    return result
  })
}

/** Live-path helper: the context when native positions are on and verified, else null. */
export const nativeCourseContextForLive = async (
  courseId: CourseId | null,
  courseKey: string | null,
): Promise<NativeCourseContext | null> => (await loadNativeCourseContext(courseId, courseKey)).context

// Pin slot for the active GSPro round. Learned from GSPro's own distance to
// pin; assumed to stay the same for the whole round (verify on the sim).
const pinSlots = new Map<string, number>()
const slotKey = (courseKey: string, roundId: number | null) => `${courseKey}|${roundId ?? 'round'}`

export const rememberNativePinSlot = (courseKey: string, roundId: number | null, slot: number) => {
  pinSlots.set(slotKey(courseKey, roundId), slot)
  try {
    window.sessionStorage.setItem(`looper.native-pin-slot.${slotKey(courseKey, roundId)}`, String(slot))
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

export const recallNativePinSlot = (courseKey: string, roundId: number | null): number | null => {
  const key = slotKey(courseKey, roundId)
  const cached = pinSlots.get(key)
  if (cached != null) return cached
  try {
    const stored = Number(window.sessionStorage.getItem(`looper.native-pin-slot.${key}`))
    return Number.isInteger(stored) && stored > 0 ? stored : null
  } catch {
    return null
  }
}
