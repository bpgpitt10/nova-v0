import type { Shot } from '../types'

export const toggleFeltPerfectShot = (
  shot: Shot,
  source: 'session_intelligence' | 'data_management',
): Shot => {
  if (shot.feltPerfect) {
    return {
      ...shot,
      feltPerfect: undefined,
      feltPerfectTaggedAt: undefined,
      feltPerfectSource: undefined,
    }
  }

  return {
    ...shot,
    feltPerfect: true,
    feltPerfectTaggedAt: new Date().toISOString(),
    feltPerfectSource: source,
  }
}
