export type HumanShotJudgment =
  | 'normal'
  | 'mishit'
  | 'severe_mishit'
  | 'intentional'
  | 'unsure'

export type HumanShotReview = {
  shotId: string
  sessionId?: string
  judgment?: HumanShotJudgment
  note?: string
  reviewedAt: string
}

export type HumanShotReviewMap = Record<string, HumanShotReview>

type HumanShotReviewPatch = {
  sessionId?: string
  judgment?: HumanShotJudgment | null
  note?: string | null
}

const STORAGE_KEY = 'looper-human-shot-reviews-v1'

const isHumanShotJudgment = (value: unknown): value is HumanShotJudgment =>
  value === 'normal' ||
  value === 'mishit' ||
  value === 'severe_mishit' ||
  value === 'intentional' ||
  value === 'unsure'

export const loadHumanShotReviews = (): HumanShotReviewMap => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }

    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    const normalized: HumanShotReviewMap = {}
    Object.entries(parsed as Record<string, unknown>).forEach(([shotId, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return
      }

      const review = value as Record<string, unknown>
      const judgment = isHumanShotJudgment(review.judgment)
        ? review.judgment
        : undefined
      const note = typeof review.note === 'string' ? review.note : undefined
      const sessionId = typeof review.sessionId === 'string' ? review.sessionId : undefined
      const reviewedAt =
        typeof review.reviewedAt === 'string'
          ? review.reviewedAt
          : new Date(0).toISOString()

      if (!judgment && !note?.trim()) {
        return
      }

      normalized[shotId] = {
        shotId,
        sessionId,
        judgment,
        note,
        reviewedAt,
      }
    })

    return normalized
  } catch {
    return {}
  }
}

export const saveHumanShotReviews = (reviews: HumanShotReviewMap) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reviews))
}

export const updateHumanShotReview = (
  shotId: string,
  patch: HumanShotReviewPatch,
): HumanShotReviewMap => {
  const reviews = loadHumanShotReviews()
  const previous = reviews[shotId]
  const hasJudgmentPatch = Object.prototype.hasOwnProperty.call(patch, 'judgment')
  const hasNotePatch = Object.prototype.hasOwnProperty.call(patch, 'note')

  const judgment = hasJudgmentPatch
    ? patch.judgment ?? undefined
    : previous?.judgment
  const note = hasNotePatch ? patch.note ?? undefined : previous?.note
  const sessionId = patch.sessionId ?? previous?.sessionId

  if (!judgment && !note?.trim()) {
    const next = { ...reviews }
    delete next[shotId]
    saveHumanShotReviews(next)
    return next
  }

  const next: HumanShotReviewMap = {
    ...reviews,
    [shotId]: {
      shotId,
      sessionId,
      judgment,
      note,
      reviewedAt: new Date().toISOString(),
    },
  }

  saveHumanShotReviews(next)
  return next
}
