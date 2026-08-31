import type { SessionMetadata, SessionSource, Shot } from '../types'

export type LegacySessionFeedMode = 'mock' | 'real'

export const SESSION_SOURCE_PARAM = 'source'
export const LEGACY_SESSION_FEED_PARAM = 'feed'

export const resolveSessionSource = (value: string | null | undefined): SessionSource | null => {
  switch (value) {
    case 'nova':
    case 'gspro':
    case 'mock':
      return value
    case 'simread':
      return 'gspro'
    case 'real':
      return 'nova'
    default:
      return null
  }
}

export const sessionSourceFromLegacyFeedMode = (
  feedMode: LegacySessionFeedMode | undefined,
): SessionSource | null => {
  if (feedMode === 'mock') {
    return 'mock'
  }
  if (feedMode === 'real') {
    return 'nova'
  }
  return null
}

export const legacyFeedModeForSessionSource = (
  source: SessionSource,
): LegacySessionFeedMode => (source === 'mock' ? 'mock' : 'real')

export const sessionSourceFromMetadata = (
  metadata: SessionMetadata | undefined,
): SessionSource | null =>
  resolveSessionSource(metadata?.source) ?? sessionSourceFromLegacyFeedMode(metadata?.feedMode)

export const sessionSourceFromSearchParams = (search: URLSearchParams | null) =>
  resolveSessionSource(search?.get(SESSION_SOURCE_PARAM)) ??
  resolveSessionSource(search?.get(LEGACY_SESSION_FEED_PARAM)) ??
  'gspro'

// Keep legacy persisted shot-source values readable while the web migration is in progress.
// New live sessions are GSPro-first; the underlying Shot union can be migrated separately
// without rewriting historical session data in place.
export const shotSourceForSessionSource = (source: SessionSource): Shot['source'] => {
  if (source === 'mock') {
    return 'mock'
  }
  if (source === 'gspro') {
    return 'simread'
  }
  return 'nova'
}

export const sessionSourceLabel = (source: SessionSource) => {
  switch (source) {
    case 'nova':
      return 'Nova (legacy)'
    case 'gspro':
      return 'GSPro'
    case 'mock':
      return 'Mock'
  }
}
