import { RETIRED_HUMAN_SHOT_REVIEWS_STORAGE_KEY } from './localUserScope'

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

const purgeRetiredStorage = () => {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(RETIRED_HUMAN_SHOT_REVIEWS_STORAGE_KEY)
  }
}

/**
 * Human mishit review labels were validation-only legacy state. They are no
 * longer persisted or consumed as player data. Keep this compatibility surface
 * temporarily so older validation UI can render without recreating the retired
 * shared-browser storage key.
 */
export const loadHumanShotReviews = (): HumanShotReviewMap => {
  purgeRetiredStorage()
  return {}
}

export const saveHumanShotReviews = (_reviews: HumanShotReviewMap) => {
  purgeRetiredStorage()
}

export const updateHumanShotReview = (
  _shotId: string,
  _patch: HumanShotReviewPatch,
): HumanShotReviewMap => {
  purgeRetiredStorage()
  return {}
}
