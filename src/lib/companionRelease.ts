/**
 * Where players get the Looper Companion (the Windows tray app on the GSPro
 * PC), and whether the one they're running is current.
 *
 * Builds are published to a public, releases-only GitHub repo by the
 * companion workflow (`build-looper-companion-windows.yml`), which also
 * writes `latest.json` there. The app reads that file (raw.githubusercontent
 * sends CORS headers) and compares it with the running companion's `release`.
 */

export const COMPANION_RELEASES_REPO = 'bpgpitt10/looper-companion-releases'
export const COMPANION_RELEASES_PAGE = `https://github.com/${COMPANION_RELEASES_REPO}/releases/latest`
export const COMPANION_DOWNLOAD_URL =
  `https://github.com/${COMPANION_RELEASES_REPO}/releases/latest/download/LooperCompanionSetup.exe`
export const COMPANION_LATEST_URL =
  `https://raw.githubusercontent.com/${COMPANION_RELEASES_REPO}/main/latest.json`

export type CompanionLatest = Readonly<{
  /** Newest release, e.g. "1.2.0". */
  release: string
  /** Oldest release the current site still works with. */
  minRelease: string
  url: string
  sha256?: string | null
  publishedAt?: string | null
  notes?: string | null
  sizeBytes?: number | null
  /**
   * The newest release that matters to play (a bug fix, not a nicety). Anyone
   * on an older companion gets the red update box, however many small
   * releases have come out since.
   */
  importantRelease?: string | null
  /** One line: the bug that release fixed. */
  bugFix?: string | null
  /** One optional line: what else is new. */
  feature?: string | null
}>

const CACHE_KEY = 'looper.companion-latest.v1'
const CACHE_MS = 60 * 60 * 1000
let memo: { at: number; latest: CompanionLatest | null } | null = null

/** One short line of plain text, or null. Long text belongs in the release notes. */
const line = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 160) : null
}

export const parseLatest = (value: unknown): CompanionLatest | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.release !== 'string' || typeof v.url !== 'string') return null
  return {
    release: v.release,
    minRelease: typeof v.minRelease === 'string' ? v.minRelease : '0.0.0',
    url: v.url,
    sha256: typeof v.sha256 === 'string' ? v.sha256 : null,
    publishedAt: typeof v.publishedAt === 'string' ? v.publishedAt : null,
    notes: typeof v.notes === 'string' ? v.notes : null,
    sizeBytes: typeof v.sizeBytes === 'number' ? v.sizeBytes : null,
    importantRelease: typeof v.importantRelease === 'string' && v.importantRelease.trim() ? v.importantRelease.trim() : null,
    bugFix: line(v.bugFix),
    feature: line(v.feature),
  }
}

/** The newest published companion, or null when it can't be read (offline, not published yet). */
export const fetchLatestCompanionRelease = async (): Promise<CompanionLatest | null> => {
  const now = Date.now()
  if (memo && now - memo.at < CACHE_MS) return memo.latest
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (raw) {
      const cached = JSON.parse(raw) as { at: number; latest: unknown }
      if (now - cached.at < CACHE_MS) {
        memo = { at: cached.at, latest: parseLatest(cached.latest) }
        return memo.latest
      }
    }
  } catch {
    // storage unavailable: fall through to the network
  }
  let latest: CompanionLatest | null = null
  try {
    const response = await fetch(COMPANION_LATEST_URL, { cache: 'no-store' })
    if (response.ok) latest = parseLatest(await response.json())
  } catch {
    latest = null
  }
  memo = { at: now, latest }
  try {
    if (latest) window.localStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, latest }))
  } catch {
    // ignore
  }
  return latest
}

/**
 * Orders release strings. Semver-ish ("1.2.0", "1.10") compare numerically
 * part by part; anything else (the older "courses.10" style) sorts below
 * every numbered release, since those builds predate release numbers.
 */
export const compareReleases = (a: string | null | undefined, b: string | null | undefined): number => {
  const parts = (s: string | null | undefined) => {
    const m = /^v?(\d+(?:\.\d+)*)/.exec((s ?? '').trim())
    return m ? m[1].split('.').map(Number) : null
  }
  const pa = parts(a), pb = parts(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export type CompanionUpdateState = 'current' | 'update-available' | 'needs-update' | 'unknown'

/** How the running companion stands against the newest published one. */
export const companionUpdateState = (
  installed: string | null | undefined,
  latest: CompanionLatest | null,
): CompanionUpdateState => {
  if (!latest) return 'unknown'
  if (compareReleases(installed, latest.minRelease) < 0) return 'needs-update'
  if (compareReleases(installed, latest.release) < 0) return 'update-available'
  return 'current'
}

export type CompanionUpdateNotice = Readonly<{
  /** required: Looper no longer works with this companion. important: a bug fix that affects play. */
  level: 'required' | 'important'
  installed: string | null
  release: string
  bugFix: string | null
  feature: string | null
}>

/**
 * The red update box, or null when a quiet "update available" (or nothing) is
 * enough. Small releases never raise it; a release marked important does for
 * everyone still behind it.
 */
export const companionUpdateNotice = (
  installed: string | null | undefined,
  latest: CompanionLatest | null,
): CompanionUpdateNotice | null => {
  if (!latest) return null
  const required = compareReleases(installed, latest.minRelease) < 0
  const important = latest.importantRelease != null
    && compareReleases(installed, latest.importantRelease) < 0
    && compareReleases(latest.importantRelease, latest.release) <= 0
  if (!required && !important) return null
  return {
    level: required ? 'required' : 'important',
    installed: installed ?? null,
    release: latest.release,
    bugFix: important ? latest.bugFix ?? null : null,
    feature: important ? latest.feature ?? null : null,
  }
}

/** True in a browser on Windows: the companion can be installed on this machine. */
export const isWindowsBrowser = (): boolean => {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return /Windows/i.test(platform ?? '') || /Windows NT/i.test(ua)
}

export const formatReleaseSize = (bytes: number | null | undefined): string | null =>
  bytes && bytes > 0 ? `${(bytes / 1_048_576).toFixed(0)} MB` : null
