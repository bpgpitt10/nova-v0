import { confidenceConfig } from './confidenceConfig'

const KNOWN_SHOT_RANKS = new Set(['S+', 'S', 'A', 'B', 'C', 'D', 'E', '1', '2', '3', '4', '5'])
const warnedUnknownRanks = new Set<string>()

const warnUnknownShotRank = (rank: string) => {
  // Keep unknown values safe at runtime, but surface them during development so
  // new OpenGolfCoach enums do not silently stay unmapped forever.
  if (!import.meta.env.DEV || warnedUnknownRanks.has(rank)) {
    return
  }
  warnedUnknownRanks.add(rank)
  console.warn('[shot-rank] Unrecognized shot rank encountered; using safe fallback weight.', {
    rank,
  })
}

export const normalizeShotRank = (value: number | string | undefined) => {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return undefined
    }
    const normalizedNumber = String(Math.trunc(value))
    if (KNOWN_SHOT_RANKS.has(normalizedNumber)) {
      return normalizedNumber
    }
    warnUnknownShotRank(normalizedNumber)
    return normalizedNumber
  }

  const normalized = value.trim().toUpperCase().replace(/\s+/g, '')
  if (!normalized) {
    return undefined
  }
  if (KNOWN_SHOT_RANKS.has(normalized)) {
    return normalized
  }

  warnUnknownShotRank(normalized)
  return normalized
}

export const formatShotRank = (value: number | string | undefined) =>
  normalizeShotRank(value) ?? '-'

export const shotRankWeight = (value: number | string | undefined) => {
  const normalized = normalizeShotRank(value)
  if (!normalized) {
    return 1
  }
  return confidenceConfig.distanceWindow.rankWeights[normalized] ?? 1
}

export const shotRankScoreTone = (value: number | string | undefined) => {
  const normalized = normalizeShotRank(value)
  if (normalized === 'S+' || normalized === 'S' || normalized === 'A' || normalized === '1') {
    return { label: 'GOOD', tone: 'good' as const }
  }
  if (normalized === 'B' || normalized === '2' || normalized === 'C' || normalized === '3') {
    return { label: 'NEUTRAL', tone: 'neutral' as const }
  }
  if (
    normalized === 'D' ||
    normalized === '4' ||
    normalized === 'E' ||
    normalized === '5'
  ) {
    return { label: 'POOR', tone: 'poor' as const }
  }
  return { label: 'NEUTRAL', tone: 'neutral' as const }
}
