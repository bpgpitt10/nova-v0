import type { LiveShotState } from './types'

export type FrozenPreShotState = Readonly<{
  frozenAt: string
  state: LiveShotState
}>

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child))
  }
  return value
}

/**
 * Freeze a detached copy of the most recent pre-impact state. The impact/final
 * shot event wiring intentionally lives outside this utility so the state can
 * first be validated in the Greywolf diagnostic screen.
 */
export const freezePreShotState = (state: LiveShotState): FrozenPreShotState => {
  const copied = structuredClone(state)
  return deepFreeze({
    frozenAt: new Date().toISOString(),
    state: copied,
  })
}
