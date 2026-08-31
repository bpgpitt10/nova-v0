export type GsproFileHandle = {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
  queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
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

let sqlJsPromise: Promise<SqlJsStatic> | null = null
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

export const isGsproBrowserFileAccessSupported = () =>
  typeof window !== 'undefined' && Boolean(getWindow().showOpenFilePicker)

export const pickGsproDatabase = async (): Promise<GsproFileHandle> => {
  const picker = getWindow().showOpenFilePicker
  if (!picker) {
    throw new Error('Direct GSPro file access requires desktop Chrome or another supported browser.')
  }

  const [handle] = await picker({
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

export const selectGsproDatabaseForSession = async () => {
  const handle = await pickGsproDatabase()
  activeGsproDatabaseHandle = handle
  return handle
}

export const getSelectedGsproDatabase = () => activeGsproDatabaseHandle

export const clearSelectedGsproDatabase = () => {
  activeGsproDatabaseHandle = null
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
    if (!row) {
      return null
    }

    const [id, dateCreated, shotData] = row
    if (typeof id !== 'number' || typeof shotData !== 'string') {
      throw new Error('Latest DrivingRangeShot row did not have the expected GSPro shape.')
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
