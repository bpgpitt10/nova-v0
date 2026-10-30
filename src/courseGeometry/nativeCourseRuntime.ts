import { getCourseCatalogEntry, type CourseId } from './courseCatalog'
import { parseGkdLayout, sha256Hex, type NativeCourseLayout } from './nativeGkd'
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
const MAX_SUBFOLDERS_SCANNED = 600

type PermissionMode = { mode: 'read' | 'readwrite' }
type FileHandleLike = { getFile(): Promise<File> }
type EntryLike = { kind: 'file' | 'directory'; name: string }
export type NativeDirectoryHandle = EntryLike & {
  kind: 'directory'
  getFileHandle(name: string): Promise<FileHandleLike>
  getDirectoryHandle(name: string): Promise<NativeDirectoryHandle>
  values?: () => AsyncIterable<EntryLike & Partial<NativeDirectoryHandle>>
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
  | Readonly<{ state: 'ready'; courseKey: string; grade: string; courseName: string }>

export type NativeCourseContext = Readonly<{
  courseId: CourseId
  courseKey: string
  layout: NativeCourseLayout
  registration: NativeRegistration
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

const readGkdText = async (folder: NativeDirectoryHandle, courseKey: string): Promise<string | null> => {
  const names = [`${courseKey}.GKD`, `${courseKey}.gkd`]
  const tryFolder = async (dir: NativeDirectoryHandle) => {
    for (const name of names) {
      try {
        return await (await (await dir.getFileHandle(name)).getFile()).text()
      } catch {
        // try next spelling
      }
    }
    return null
  }
  const direct = await tryFolder(folder)
  if (direct != null) return direct
  try {
    return await tryFolder(await folder.getDirectoryHandle(courseKey))
  } catch {
    // not a direct subfolder by that name
  }
  if (!folder.values) return null
  let scanned = 0
  for await (const entry of folder.values()) {
    if (entry.kind !== 'directory' || !entry.getFileHandle) continue
    scanned += 1
    if (scanned > MAX_SUBFOLDERS_SCANNED) break
    const found = await tryFolder(entry as NativeDirectoryHandle)
    if (found != null) return found
  }
  return null
}

const registrationUrl = (courseId: CourseId) => {
  const packageUrl = getCourseCatalogEntry(courseId).staticPackageUrl
  return packageUrl ? packageUrl.replace(/course-v1\.json$/, 'native-registration-v1.json') : null
}

const loadContext = async (courseId: CourseId, courseKey: string | null): Promise<LoadResult> => {
  const entry = getCourseCatalogEntry(courseId)
  const url = registrationUrl(courseId)
  const response = url ? await fetch(url, { cache: 'no-cache' }).catch(() => null) : null
  const registration = response?.ok ? parseNativeRegistration(await response.json().catch(() => null)) : null
  if (!registration) return { context: null, status: { state: 'no-registration', courseName: entry.name } }
  if (courseKey && courseKey !== registration.gsproCourseKey) {
    return { context: null, status: { state: 'other-course', courseKey, expectedKey: registration.gsproCourseKey } }
  }
  const key = registration.gsproCourseKey
  const folder = await loadCoursesFolderHandle()
  if (!folder) return { context: null, status: { state: 'no-folder' } }
  const permission = folder.queryPermission ? await folder.queryPermission({ mode: 'read' }) : 'granted'
  if (permission !== 'granted') return { context: null, status: { state: 'needs-permission' } }
  const text = await readGkdText(folder, key)
  if (text == null) return { context: null, status: { state: 'gkd-not-found', courseKey: key } }
  const layout = parseGkdLayout(text)
  if ((await sha256Hex(layout.fingerprintText)) !== registration.layoutFingerprint) {
    return { context: null, status: { state: 'layout-mismatch', courseKey: key } }
  }
  return {
    context: { courseId, courseKey: key, layout, registration },
    status: { state: 'ready', courseKey: key, grade: registration.grade, courseName: entry.name },
  }
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
