import type { BrowserGsproCourseSnapshot } from '../adapters/reliableBrowserGsproCourseState'
import { freezePreShotState, type FrozenPreShotState } from './preShotSnapshot'
import type { LiveShotState } from './types'

export type PreShotFreezeEvent = FrozenPreShotState & Readonly<{
  triggerShotKey: string
  sourceEpoch: number
}>

/**
 * Tracks the last trustworthy assembled pre-shot state and freezes it when the
 * reliable GSPro watcher exposes a new physical latestShotKey.
 *
 * Safety properties:
 * - Initial attachment to a round with an existing shot key establishes a
 *   baseline; it never fabricates a freeze for historical play.
 * - A source epoch change clears the candidate, preventing reconnect/log-reset
 *   boundaries from being interpreted as impacts.
 * - STALE assembled states never replace the freeze candidate.
 * - A null -> first real shot key transition is valid only when this tracker
 *   already observed and assembled the corresponding live pre-shot state.
 * - A new key freezes only when the candidate hole + shot number exactly match
 *   the newly completed physical shot. This suppresses rollback, mulligan
 *   deletion, same-ordinal replacement, and stale prior-hole candidates.
 */
export class PreShotStateTracker {
  private initialized = false
  private epoch: number | null = null
  private latestShotKey: string | null = null
  private candidate: LiveShotState | null = null

  reset() {
    this.initialized = false
    this.epoch = null
    this.latestShotKey = null
    this.candidate = null
  }

  observeSnapshot(snapshot: BrowserGsproCourseSnapshot): PreShotFreezeEvent | null {
    const nextEpoch = snapshot.health.epoch

    if (!this.initialized || this.epoch !== nextEpoch) {
      this.initialized = true
      this.epoch = nextEpoch
      this.latestShotKey = snapshot.latestShotKey
      this.candidate = null
      return null
    }

    const nextShotKey = snapshot.latestShotKey
    if (!nextShotKey || nextShotKey === this.latestShotKey) return null

    const candidate = this.candidate
    this.latestShotKey = nextShotKey
    this.candidate = null
    if (!candidate) return null

    const triggerHole = snapshot.latestShot?.holeNumber ?? null
    const triggerShotNumber = snapshot.latestShot?.holeShot ?? null
    const candidateHole = candidate.game.hole.value
    const candidateShotNumber = candidate.game.shotNumber.value

    const candidateMatchesTrigger =
      triggerHole != null
      && triggerShotNumber != null
      && candidateHole === triggerHole
      && candidateShotNumber === triggerShotNumber

    if (!candidateMatchesTrigger) {
      console.warn('[LiveShotState] suppressed pre-shot freeze because trigger did not match candidate', {
        triggerShotKey: nextShotKey,
        triggerHole,
        triggerShotNumber,
        candidateHole,
        candidateShotNumber,
        sourceEpoch: nextEpoch,
      })
      return null
    }

    const frozen = freezePreShotState(candidate)
    return Object.freeze({
      ...frozen,
      triggerShotKey: nextShotKey,
      sourceEpoch: nextEpoch,
    })
  }

  acceptAssembledState(
    state: LiveShotState,
    snapshot: BrowserGsproCourseSnapshot,
  ) {
    if (!this.initialized || this.epoch !== snapshot.health.epoch) return
    if (state.overallStatus === 'STALE' || snapshot.health.integrity === 'stale') return

    // A candidate can be incomplete (UNKNOWN / UNAVAILABLE) and is still worth
    // freezing for audit. Missing fields stay missing; they are never promoted
    // to guessed values. Trigger matching above decides whether it belongs to
    // the completed physical shot.
    this.candidate = state
  }
}
