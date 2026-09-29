import type { CourseId } from './courseCatalog'

export type RoundTeeSelection = Readonly<{
  courseId: CourseId
  teeSet: string
  normalizedTeeSet: string
  selectedAt: string
}>

const ROUND_TEE_SELECTION_STORAGE_KEY = 'looper.round-tee-selection.v1'
export const ROUND_TEE_SELECTION_UPDATED_EVENT = 'looper:round-tee-selection-updated'

const normalizeWhitespace = (value: string) => value.trim().replace(/\s+/g, ' ')

export const normalizeTeeSet = (value: string) => normalizeWhitespace(value).toLowerCase()

const displayTeeSet = (value: string) => normalizeWhitespace(value)

type StoredRoundTeeSelections = Record<string, RoundTeeSelection>

const parseStoredSelections = (value: string | null): StoredRoundTeeSelections => {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: StoredRoundTeeSelections = {}
    for (const [courseId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const candidate = raw as Record<string, unknown>
      if (
        typeof candidate.courseId !== 'string'
        || candidate.courseId !== courseId
        || typeof candidate.teeSet !== 'string'
        || typeof candidate.normalizedTeeSet !== 'string'
        || typeof candidate.selectedAt !== 'string'
      ) continue
      const teeSet = displayTeeSet(candidate.teeSet)
      const normalizedTeeSet = normalizeTeeSet(candidate.normalizedTeeSet)
      if (!teeSet || !normalizedTeeSet || normalizedTeeSet !== normalizeTeeSet(teeSet)) continue
      result[courseId] = {
        courseId: candidate.courseId as CourseId,
        teeSet,
        normalizedTeeSet,
        selectedAt: candidate.selectedAt,
      }
    }
    return result
  } catch {
    return {}
  }
}

const readSelections = (): StoredRoundTeeSelections => {
  if (typeof window === 'undefined') return {}
  try {
    return parseStoredSelections(window.localStorage.getItem(ROUND_TEE_SELECTION_STORAGE_KEY))
  } catch {
    return {}
  }
}

const writeSelections = (selections: StoredRoundTeeSelections) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ROUND_TEE_SELECTION_STORAGE_KEY, JSON.stringify(selections))
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

const emitUpdated = (selection: RoundTeeSelection | null, courseId: CourseId) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(ROUND_TEE_SELECTION_UPDATED_EVENT, {
    detail: { courseId, selection },
  }))
}

export const loadRoundTeeSelection = (courseId: CourseId): RoundTeeSelection | null =>
  readSelections()[courseId] ?? null

export const saveRoundTeeSelection = (
  courseId: CourseId,
  teeSetInput: string,
): RoundTeeSelection | null => {
  const teeSet = displayTeeSet(teeSetInput)
  const normalizedTeeSet = normalizeTeeSet(teeSetInput)
  if (!teeSet || !normalizedTeeSet) {
    clearRoundTeeSelection(courseId)
    return null
  }

  const selection: RoundTeeSelection = {
    courseId,
    teeSet,
    normalizedTeeSet,
    selectedAt: new Date().toISOString(),
  }
  const selections = readSelections()
  selections[courseId] = selection
  writeSelections(selections)
  emitUpdated(selection, courseId)
  return selection
}

export const clearRoundTeeSelection = (courseId: CourseId) => {
  const selections = readSelections()
  if (!(courseId in selections)) return
  delete selections[courseId]
  writeSelections(selections)
  emitUpdated(null, courseId)
}
