import type { BrowserDirectoryHandle } from './browserGsproAccess'

/**
 * GSPro's data files read through the Looper Companion instead of a browser
 * folder grant.
 *
 * The companion already finds GSPro's data folder on the sim PC. It serves
 * currentRound.dat, output_log.txt and GSPro.db read-only (allowlisted names,
 * no paths). This module wraps that in an object shaped like the browser's
 * FileSystemDirectoryHandle, so every existing reader keeps working unchanged:
 * they only call getFileHandle(name).getFile() and then text(), arrayBuffer(),
 * slice(start).text(), size and lastModified.
 */

const COMPANION_BASE = 'http://127.0.0.1:8787/companion/v1'
const AVAILABILITY_TTL_MS = 10_000
const STAT_TIMEOUT_MS = 4_000
const READ_TIMEOUT_MS = 60_000

export const COMPANION_GSPRO_FOLDER_NAME = 'GSPro (via Looper Companion)'

type CompanionFileStat =
  | { status: 'ok'; name: string; size: number; lastModified: number }
  | { status: 'not-found' | 'gspro-folder-not-found' | 'forbidden' | 'unreadable'; name: string }

export type CompanionGsproDirectoryHandle = BrowserDirectoryHandle & {
  readonly isCompanionBacked: true
}

type FetchLike = (input: Request) => Promise<Response>

let fetchImpl: FetchLike = (input) => fetch(input)
let availability: { checkedAt: number; available: boolean } | null = null
let availabilityRequest: Promise<boolean> | null = null
let sharedHandle: CompanionGsproDirectoryHandle | null = null

/** Tests only. */
export const __setCompanionFetchForTests = (next: FetchLike | null) => {
  fetchImpl = next ?? ((input) => fetch(input))
  availability = null
  availabilityRequest = null
  sharedHandle = null
}

const companionRequest = async (path: string, timeoutMs: number) => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const request = new Request(`${COMPANION_BASE}/${path}`, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
      // Chromium Local Network Access: per-site permission for loopback.
      targetAddressSpace: 'loopback',
    } as RequestInit & { targetAddressSpace: 'loopback' })
    return await fetchImpl(request)
  } finally {
    clearTimeout(timeoutId)
  }
}

const notFound = (name: string, reason: string) => {
  const error = new Error(`${name} is not available through the Looper Companion (${reason}).`)
  error.name = 'NotFoundError'
  return error
}

/**
 * True when a companion that serves GSPro files is running on this PC.
 * Cached briefly: readers poll every few seconds.
 */
export const isCompanionGsproFilesAvailable = async (): Promise<boolean> => {
  if (typeof window === 'undefined' && typeof fetch === 'undefined') return false
  const now = Date.now()
  if (availability && now - availability.checkedAt < AVAILABILITY_TTL_MS) {
    return availability.available
  }
  if (availabilityRequest) return availabilityRequest

  availabilityRequest = (async () => {
    let available = false
    try {
      const response = await companionRequest('status', STAT_TIMEOUT_MS)
      if (response.ok) {
        const data = (await response.json()) as {
          service?: unknown
          capabilities?: { gsproFiles?: unknown }
        }
        available = data.service === 'looper-companion' && data.capabilities?.gsproFiles === true
      }
    } catch {
      available = false
    }
    availability = { checkedAt: Date.now(), available }
    availabilityRequest = null
    return available
  })()
  return availabilityRequest
}

const statCompanionFile = async (name: string): Promise<CompanionFileStat> => {
  const response = await companionRequest(
    `gspro-file?name=${encodeURIComponent(name)}&stat=1`,
    STAT_TIMEOUT_MS,
  )
  if (!response.ok) throw new Error(`Looper Companion file check failed (HTTP ${response.status}).`)
  return (await response.json()) as CompanionFileStat
}

const readCompanionBytes = async (name: string, start?: number, end?: number) => {
  const range = [
    start != null ? `&start=${Math.max(0, Math.floor(start))}` : '',
    end != null ? `&end=${Math.max(0, Math.floor(end))}` : '',
  ].join('')
  const response = await companionRequest(
    `gspro-file?name=${encodeURIComponent(name)}${range}`,
    READ_TIMEOUT_MS,
  )
  if (response.status === 404) throw notFound(name, 'missing')
  if (!response.ok) throw new Error(`Looper Companion could not read ${name} (HTTP ${response.status}).`)
  return new Uint8Array(await response.arrayBuffer())
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** A File-shaped snapshot whose content is fetched only when read. */
const companionFile = (stat: { name: string; size: number; lastModified: number }) => {
  const read = (start?: number, end?: number) => readCompanionBytes(stat.name, start, end)
  const blobPart = (start: number, end: number) => ({
    size: Math.max(0, end - start),
    text: async () => decode(await read(start, end)),
    arrayBuffer: async () => (await read(start, end)).slice().buffer,
  })
  const file = {
    name: stat.name,
    size: stat.size,
    lastModified: stat.lastModified,
    type: '',
    webkitRelativePath: '',
    text: async () => decode(await read()),
    arrayBuffer: async () => (await read()).slice().buffer,
    bytes: async () => read(),
    slice: (start = 0, end = stat.size) => {
      const from = start < 0 ? Math.max(0, stat.size + start) : Math.min(start, stat.size)
      const to = end < 0 ? Math.max(0, stat.size + end) : Math.min(end, stat.size)
      return blobPart(from, Math.max(from, to))
    },
  }
  return file as unknown as File
}

const createHandle = (): CompanionGsproDirectoryHandle => ({
  kind: 'directory',
  name: COMPANION_GSPRO_FOLDER_NAME,
  isCompanionBacked: true,
  getFileHandle: async (name: string, options?: { create?: boolean }) => {
    if (options?.create) {
      throw new Error('The Looper Companion never writes to the GSPro folder.')
    }
    return {
      kind: 'file' as const,
      name,
      getFile: async () => {
        const stat = await statCompanionFile(name)
        if (stat.status !== 'ok') throw notFound(name, stat.status)
        return companionFile(stat)
      },
    }
  },
  queryPermission: async () => 'granted',
  requestPermission: async () => 'granted',
})

/** The companion-backed GSPro folder, or null when no companion is serving files. */
export const loadCompanionGsproDirectoryHandle = async (): Promise<CompanionGsproDirectoryHandle | null> => {
  if (!(await isCompanionGsproFilesAvailable())) return null
  sharedHandle ??= createHandle()
  return sharedHandle
}

export const isCompanionGsproDirectoryHandle = (
  handle: unknown,
): handle is CompanionGsproDirectoryHandle =>
  Boolean(handle && typeof handle === 'object' && (handle as { isCompanionBacked?: unknown }).isCompanionBacked === true)

export type CompanionRoundRecordEntry = {
  seq: number
  observedAt: string
  record: Record<string, unknown>
}

export type CompanionRoundRecordsPage = {
  status: 'ok' | 'unavailable'
  records: CompanionRoundRecordEntry[]
  nextAfter: number
  more: boolean
  activeRoundId?: number | string | null
}

/** Rounds the companion kept while the browser may have been closed. */
export const readCompanionRoundRecords = async (
  after: number,
  limit = 500,
): Promise<CompanionRoundRecordsPage> => {
  const response = await companionRequest(
    `round-records?after=${Math.max(0, Math.floor(after))}&limit=${Math.max(1, Math.floor(limit))}`,
    READ_TIMEOUT_MS,
  )
  if (!response.ok) throw new Error(`Looper Companion round records failed (HTTP ${response.status}).`)
  const data = (await response.json()) as Partial<CompanionRoundRecordsPage> & { service?: unknown }
  if (data.service !== 'looper-companion' || !Array.isArray(data.records)) {
    throw new Error('Unexpected round-records response from the Looper Companion.')
  }
  return {
    status: data.status === 'ok' ? 'ok' : 'unavailable',
    records: data.records,
    nextAfter: typeof data.nextAfter === 'number' ? data.nextAfter : after,
    more: data.more === true,
    activeRoundId: data.activeRoundId ?? null,
  }
}
