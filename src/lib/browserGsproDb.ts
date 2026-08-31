export type GsproFileHandle = {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
  queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

export type GsproDirectoryHandle = {
  kind: 'directory'
  name: string
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<GsproFileHandle>
  queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

export type GsproConnectionStatus = {
  remembered: boolean
  permission: PermissionState | 'unsupported'
  directoryName: string | null
  ready: boolean
}

type SqlValue = number | string | Uint8Array | null

type SqlResult = {
  columns: string[]
  values: SqlValue[][]
}

type SqlDatabase = {
  exec: (sql: string) => SqlResult[]
  close: () => void
}

type SqlJsStatic = {
  Database: new (bytes?: Uint8Array) => SqlDatabase
}

type InitSqlJs = (config?: {
  locateFile?: (file: string) => string
}) => Promise<SqlJsStatic>

type GsproBrowserWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (options?: {
      multiple?: boolean
      types?: Array<{
        description: string
        accept: Record<string, string[]>
      }>
    }) => Promise<GsproFileHandle[]>
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<GsproDirectoryHandle>
    initSqlJs?: InitSqlJs
  }

export type BrowserGsproRangeShot = {
  id: number
  dateCreated: string | number | null
  rawShotData: string
  parsedShotData: unknown
}

const SQL_JS_VERSION = '1.14.2'
const SQL_JS_BASE = `https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/dist`
const GSPRO_DATABASE_NAME = 'GSPro.db'
const HANDLE_DB_NAME = 'looper-gspro-file-access'
const HANDLE_DB_VERSION = 1
const HANDLE_STORE_NAME = 'handles'
const DIRECTORY_HANDLE_KEY = 'gspro-directory'

let sqlJsPromise: Promise<SqlJsStatic> | null = null
let activeGsproDirectoryHandle: GsproDirectoryHandle | null = null
let activeGsproDatabaseHandle: GsproFileHandle | null = null

const getWindow = () => window as GsproBrowserWindow

const loadSqlJs = () => {
  if (sqlJsPromise) {
    return sqlJsPromise
  }

  sqlJsPromise = new Promise<SqlJsStatic>((resolve, reject) => {
    const existingInit = getWindow().initSqlJs
    if (existingInit) {
      existingInit({ locateFile: (file) => `${SQL_JS_BASE}/${file}` }).then(resolve, reject)
      return
    }

    const script = document.createElement('script')
    script.src = `${SQL_JS_BASE}/sql-wasm.js`
    script.async = true
    script.onload = () => {
      const initSqlJs = getWindow().initSqlJs
      if (!initSqlJs) {
        reject(new Error('sql.js loaded but initSqlJs was not available'))
        return
      }
      initSqlJs({ locateFile: (file) => `${SQL_JS_BASE}/${file}` }).then(resolve, reject)
    }
    script.onerror = () => reject(new Error('Failed to load sql.js'))
    document.head.appendChild(script)
  })

  return sqlJsPromise
}

const rowToRangeShot = (row: SqlValue[]): BrowserGsproRangeShot => {
  const [id, dateCreated, shotData] = row
  if (typeof id !== 'number' || typeof shotData !== 'string') {
    throw new Error('DrivingRangeShot row did not have the expected GSPro shape.')
  }

  let parsedShotData: unknown = shotData
  try {
    parsedShotData = JSON.parse(shotData)
  } catch {
    // Preserve the raw text so capture failures remain diagnosable.
  }

  return {
    id,
    dateCreated:
      typeof dateCreated === 'number' || typeof dateCreated === 'string' || dateCreated === null
        ? dateCreated
        : null,
    rawShotData: shotData,
    parsedShotData,
  }
}

const openHandleDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'))
      return
    }

    const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        database.createObjectStore(HANDLE_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open GSPro browser storage.'))
  })

const readRememberedDirectoryHandle = async (): Promise<GsproDirectoryHandle | null> => {
  const database = await openHandleDatabase()
  try {
    return await new Promise<GsproDirectoryHandle | null>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, 'readonly')
      const request = transaction.objectStore(HANDLE_STORE_NAME).get(DIRECTORY_HANDLE_KEY)
      request.onsuccess = () => {
        const value = request.result as GsproDirectoryHandle | undefined
        resolve(value?.kind === 'directory' ? value : null)
      }
      request.onerror = () => reject(request.error ?? new Error('Could not read remembered GSPro folder.'))
    })
  } finally {
    database.close()
  }
}

const rememberDirectoryHandle = async (handle: GsproDirectoryHandle) => {
  const database = await openHandleDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, 'readwrite')
      transaction.objectStore(HANDLE_STORE_NAME).put(handle, DIRECTORY_HANDLE_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not remember GSPro folder.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Remembering GSPro folder was aborted.'))
    })
  } finally {
    database.close()
  }
}

const forgetDirectoryHandle = async () => {
  const database = await openHandleDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, 'readwrite')
      transaction.objectStore(HANDLE_STORE_NAME).delete(DIRECTORY_HANDLE_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not forget GSPro folder.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Forgetting GSPro folder was aborted.'))
    })
  } finally {
    database.close()
  }
}

const queryReadPermission = async (handle: GsproDirectoryHandle): Promise<PermissionState> => {
  if (!handle.queryPermission) {
    return 'prompt'
  }
  return handle.queryPermission({ mode: 'read' })
}

const ensureReadPermission = async (handle: GsproDirectoryHandle) => {
  let permission = await queryReadPermission(handle)
  if (permission === 'granted') {
    return permission
  }

  if (!handle.requestPermission) {
    return permission
  }

  permission = await handle.requestPermission({ mode: 'read' })
  return permission
}

const databaseHandleFromDirectory = async (directory: GsproDirectoryHandle) => {
  try {
    return await directory.getFileHandle(GSPRO_DATABASE_NAME, { create: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `That folder does not contain ${GSPRO_DATABASE_NAME}. Select the GSPro data folder that contains ${GSPRO_DATABASE_NAME}. ${message}`,
    )
  }
}

const activateDirectory = async (directory: GsproDirectoryHandle) => {
  const databaseHandle = await databaseHandleFromDirectory(directory)
  activeGsproDirectoryHandle = directory
  activeGsproDatabaseHandle = databaseHandle
  return databaseHandle
}

export const isGsproBrowserFileAccessSupported = () =>
  typeof window !== 'undefined' && Boolean(getWindow().showDirectoryPicker)

export const pickGsproDatabase = async (): Promise<GsproFileHandle> => {
  const gsproWindow = getWindow()
  const picker = gsproWindow.showOpenFilePicker
  if (!picker) {
    throw new Error('Direct GSPro file access requires desktop Chrome or another supported browser.')
  }

  const [handle] = await picker.call(gsproWindow, {
    multiple: false,
    types: [
      {
        description: 'GSPro database',
        accept: {
          'application/octet-stream': ['.db'],
        },
      },
    ],
  })

  if (!handle) {
    throw new Error('No GSPro database was selected.')
  }

  return handle
}

export const pickAndRememberGsproDirectory = async () => {
  const gsproWindow = getWindow()
  const picker = gsproWindow.showDirectoryPicker
  if (!picker) {
    throw new Error('Remembered GSPro folder access requires desktop Chrome or another supported browser.')
  }

  const directory = await picker.call(gsproWindow, { mode: 'read' })
  await activateDirectory(directory)
  await rememberDirectoryHandle(directory)
  return directory
}

export const getGsproConnectionStatus = async (): Promise<GsproConnectionStatus> => {
  if (!isGsproBrowserFileAccessSupported()) {
    return {
      remembered: false,
      permission: 'unsupported',
      directoryName: null,
      ready: false,
    }
  }

  const directory = activeGsproDirectoryHandle ?? (await readRememberedDirectoryHandle())
  if (!directory) {
    return {
      remembered: false,
      permission: 'prompt',
      directoryName: null,
      ready: false,
    }
  }

  const permission = await queryReadPermission(directory)
  if (permission === 'granted') {
    try {
      await activateDirectory(directory)
      return {
        remembered: true,
        permission,
        directoryName: directory.name,
        ready: true,
      }
    } catch {
      return {
        remembered: true,
        permission,
        directoryName: directory.name,
        ready: false,
      }
    }
  }

  return {
    remembered: true,
    permission,
    directoryName: directory.name,
    ready: false,
  }
}

export const prepareGsproDatabaseForSession = async () => {
  if (activeGsproDatabaseHandle) {
    return activeGsproDatabaseHandle
  }

  const rememberedDirectory = await readRememberedDirectoryHandle()
  if (!rememberedDirectory) {
    await pickAndRememberGsproDirectory()
    if (!activeGsproDatabaseHandle) {
      throw new Error('GSPro folder was selected but GSPro.db could not be activated.')
    }
    return activeGsproDatabaseHandle
  }

  const permission = await ensureReadPermission(rememberedDirectory)
  if (permission !== 'granted') {
    throw new Error('Chrome did not grant Looper permission to read the remembered GSPro folder.')
  }

  return activateDirectory(rememberedDirectory)
}

// Compatibility entry point for the existing live-session flow.
export const selectGsproDatabaseForSession = prepareGsproDatabaseForSession

export const getSelectedGsproDatabase = () => activeGsproDatabaseHandle

export const clearSelectedGsproDatabase = () => {
  activeGsproDatabaseHandle = null
}

export const disconnectRememberedGsproDirectory = async () => {
  activeGsproDirectoryHandle = null
  activeGsproDatabaseHandle = null
  await forgetDirectoryHandle()
}

export const gsproFileSignature = (file: File) => `${file.lastModified}:${file.size}`

export const readLatestGsproRangeShotFromFile = async (
  file: File,
): Promise<BrowserGsproRangeShot | null> => {
  const SQL = await loadSqlJs()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const db = new SQL.Database(bytes)

  try {
    const result = db.exec(
      'SELECT ID, DateCreated, ShotData FROM DrivingRangeShot ORDER BY ID DESC LIMIT 1',
    )[0]
    const row = result?.values?.[0]
    return row ? rowToRangeShot(row) : null
  } finally {
    db.close()
  }
}

export const readGsproRangeShotsAfterIdFromFile = async (
  file: File,
  afterId: number,
  limit = 25,
): Promise<BrowserGsproRangeShot[]> => {
  const SQL = await loadSqlJs()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const db = new SQL.Database(bytes)
  const safeAfterId = Math.max(0, Math.floor(afterId))
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)))

  try {
    const result = db.exec(
      `SELECT ID, DateCreated, ShotData FROM DrivingRangeShot WHERE ID > ${safeAfterId} ORDER BY ID ASC LIMIT ${safeLimit}`,
    )[0]
    return result?.values?.map(rowToRangeShot) ?? []
  } finally {
    db.close()
  }
}

export const readLatestGsproRangeShot = async (
  handle: GsproFileHandle,
): Promise<{ file: File; shot: BrowserGsproRangeShot | null }> => {
  const file = await handle.getFile()
  const shot = await readLatestGsproRangeShotFromFile(file)
  return { file, shot }
}
