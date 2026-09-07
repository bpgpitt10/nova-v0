type BrowserPermissionMode = 'read' | 'readwrite'
type BrowserPermissionState = 'granted' | 'denied' | 'prompt'

type BrowserPermissionDescriptor = {
  mode?: BrowserPermissionMode
}

type BrowserFileHandle = {
  kind: 'file'
  name: string
  getFile(): Promise<File>
}

export type BrowserDirectoryHandle = {
  kind: 'directory'
  name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle>
  queryPermission?(options?: BrowserPermissionDescriptor): Promise<BrowserPermissionState>
  requestPermission?(options?: BrowserPermissionDescriptor): Promise<BrowserPermissionState>
}

type BrowserPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: BrowserPermissionMode
    startIn?: unknown
  }) => Promise<BrowserDirectoryHandle>
}

type SqlValue = number | string | Uint8Array | null

type SqlResult = {
  columns: string[]
  values: SqlValue[][]
}

type SqlDatabase = {
  exec(sql: string): SqlResult[]
  close(): void
}

type SqlStatic = {
  Database: new (data?: Uint8Array) => SqlDatabase
}

type InitSqlJs = (config: {
  locateFile: (filename: string) => string
}) => Promise<SqlStatic>

type SqlWindow = Window & {
  initSqlJs?: InitSqlJs
}

export type BrowserGsproLatestShot = {
  rowId: number
  dateCreated: string | number | null
  shotDataText: string
  shotData: unknown
  databaseSizeBytes: number
  databaseLastModified: number
}

export type BrowserGsproDatabaseState = {
  size: number
  lastModified: number
}

const HANDLE_DATABASE_NAME = 'looper-browser-gspro'
const HANDLE_STORE_NAME = 'handles'
const HANDLE_KEY = 'gspro-directory'
export const GSPRO_DATABASE_NAME = 'GSPro.db'
const SQL_JS_VERSION = '1.14.2'
const SQL_JS_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/dist/sql-wasm.js`
const SQL_JS_WASM_URL = `https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/dist/sql-wasm.wasm`

let sqlJsPromise: Promise<SqlStatic> | null = null

const openHandleDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DATABASE_NAME, 1)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        database.createObjectStore(HANDLE_STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open browser handle storage.'))
  })

const loadSqlJs = () => {
  if (sqlJsPromise) {
    return sqlJsPromise
  }

  sqlJsPromise = new Promise<SqlStatic>((resolve, reject) => {
    const browserWindow = window as SqlWindow

    const initialize = () => {
      const initSqlJs = browserWindow.initSqlJs
      if (!initSqlJs) {
        reject(new Error('sql.js loaded but initSqlJs was unavailable.'))
        return
      }

      initSqlJs({
        locateFile: () => SQL_JS_WASM_URL,
      }).then(resolve, reject)
    }

    if (browserWindow.initSqlJs) {
      initialize()
      return
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[data-looper-sql-js="${SQL_JS_VERSION}"]`,
    )

    if (existingScript) {
      existingScript.addEventListener('load', initialize, { once: true })
      existingScript.addEventListener(
        'error',
        () => reject(new Error('Could not load the browser SQLite reader.')),
        { once: true },
      )
      return
    }

    const script = document.createElement('script')
    script.src = SQL_JS_SCRIPT_URL
    script.async = true
    script.dataset.looperSqlJs = SQL_JS_VERSION
    script.addEventListener('load', initialize, { once: true })
    script.addEventListener(
      'error',
      () => reject(new Error('Could not load the browser SQLite reader.')),
      { once: true },
    )
    document.head.appendChild(script)
  })

  return sqlJsPromise
}

export const isBrowserGsproAccessSupported = () =>
  typeof window !== 'undefined' &&
  typeof (window as BrowserPickerWindow).showDirectoryPicker === 'function' &&
  typeof indexedDB !== 'undefined'

export const chooseGsproDirectory = async () => {
  const picker = (window as BrowserPickerWindow).showDirectoryPicker
  if (!picker) {
    throw new Error('This browser does not support direct folder access. Use desktop Chrome or Edge.')
  }

  return picker({
    id: 'looper-gspro-directory',
    mode: 'readwrite',
  })
}

export const saveGsproDirectoryHandle = async (handle: BrowserDirectoryHandle) => {
  const database = await openHandleDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, 'readwrite')
      const request = transaction.objectStore(HANDLE_STORE_NAME).put(handle, HANDLE_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Could not save the GSPro folder handle.'))
    })
  } finally {
    database.close()
  }
}

export const loadGsproDirectoryHandle = async () => {
  const database = await openHandleDatabase()

  try {
    return await new Promise<BrowserDirectoryHandle | null>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, 'readonly')
      const request = transaction.objectStore(HANDLE_STORE_NAME).get(HANDLE_KEY)
      request.onsuccess = () => resolve((request.result as BrowserDirectoryHandle | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('Could not restore the GSPro folder handle.'))
    })
  } finally {
    database.close()
  }
}

export const clearGsproDirectoryHandle = async () => {
  const database = await openHandleDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE_NAME, 'readwrite')
      const request = transaction.objectStore(HANDLE_STORE_NAME).delete(HANDLE_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Could not clear the saved GSPro folder handle.'))
    })
  } finally {
    database.close()
  }
}

export const queryGsproDirectoryPermission = async (
  handle: BrowserDirectoryHandle,
  mode: BrowserPermissionMode = 'readwrite',
): Promise<BrowserPermissionState> => {
  if (!handle.queryPermission) {
    return 'prompt'
  }

  return handle.queryPermission({ mode })
}

export const requestGsproDirectoryPermission = async (
  handle: BrowserDirectoryHandle,
  mode: BrowserPermissionMode = 'readwrite',
): Promise<BrowserPermissionState> => {
  const current = await queryGsproDirectoryPermission(handle, mode)
  if (current === 'granted') {
    return current
  }

  if (!handle.requestPermission) {
    return current
  }

  return handle.requestPermission({ mode })
}

const parseLatestRow = (
  values: SqlValue[],
  databaseFile: File,
): BrowserGsproLatestShot => {
  const [id, dateCreated, shotData] = values

  if (typeof id !== 'number') {
    throw new Error('DrivingRangeShot.ID was not numeric.')
  }

  if (typeof shotData !== 'string') {
    throw new Error('DrivingRangeShot.ShotData was not JSON text.')
  }

  if (
    dateCreated !== null &&
    typeof dateCreated !== 'string' &&
    typeof dateCreated !== 'number'
  ) {
    throw new Error('DrivingRangeShot.DateCreated had an unexpected type.')
  }

  let parsedShotData: unknown = shotData
  try {
    parsedShotData = JSON.parse(shotData) as unknown
  } catch {
    // Keep the original text available if GSPro ever changes the payload format.
  }

  return {
    rowId: id,
    dateCreated,
    shotDataText: shotData,
    shotData: parsedShotData,
    databaseSizeBytes: databaseFile.size,
    databaseLastModified: databaseFile.lastModified,
  }
}

export const readGsproDatabaseState = async (
  directoryHandle: BrowserDirectoryHandle,
): Promise<BrowserGsproDatabaseState> => {
  const databaseHandle = await directoryHandle.getFileHandle(GSPRO_DATABASE_NAME)
  const databaseFile = await databaseHandle.getFile()
  return {
    size: databaseFile.size,
    lastModified: databaseFile.lastModified,
  }
}

export const readLatestGsproRangeShot = async (
  directoryHandle: BrowserDirectoryHandle,
): Promise<BrowserGsproLatestShot | null> => {
  const databaseHandle = await directoryHandle.getFileHandle(GSPRO_DATABASE_NAME)
  const databaseFile = await databaseHandle.getFile()
  const bytes = new Uint8Array(await databaseFile.arrayBuffer())
  const SQL = await loadSqlJs()
  const database = new SQL.Database(bytes)

  try {
    const result = database.exec(
      'SELECT ID, DateCreated, ShotData FROM DrivingRangeShot ORDER BY ID DESC LIMIT 1',
    )
    const row = result[0]?.values[0]
    return row ? parseLatestRow(row, databaseFile) : null
  } finally {
    database.close()
  }
}
