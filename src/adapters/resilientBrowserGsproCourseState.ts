import {
  connectBrowserGsproCourseStateFolder,
  connectToBrowserGsproCourseState as connectReliableGsproCourseState,
  prepareBrowserGsproCourseStateRuntime,
  type BrowserGsproCourseConnection,
  type BrowserGsproCourseShot,
  type BrowserGsproCourseSnapshot,
  type BrowserGsproCourseStatus,
} from './reliableBrowserGsproCourseState'

export {
  connectBrowserGsproCourseStateFolder,
  prepareBrowserGsproCourseStateRuntime,
}
export type {
  BrowserGsproCourseConnection,
  BrowserGsproCourseShot,
  BrowserGsproCourseSnapshot,
  BrowserGsproCourseStatus,
} from './reliableBrowserGsproCourseState'

type ShotDeliveryWatermark = {
  key: string
  roundSignature: string | null
  deliveredAt: string
}

const SHOT_WATERMARK_STORAGE_KEY = 'looper.gspro-live.shot-watermark.v1'
const INITIAL_HEALTH_GRACE_MS = 1_500

const loadShotWatermark = (): ShotDeliveryWatermark | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SHOT_WATERMARK_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ShotDeliveryWatermark>
    if (typeof parsed.key !== 'string' || !parsed.key) return null
    return {
      key: parsed.key,
      roundSignature: typeof parsed.roundSignature === 'string' ? parsed.roundSignature : null,
      deliveredAt: typeof parsed.deliveredAt === 'string' ? parsed.deliveredAt : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

const saveShotWatermark = (snapshot: BrowserGsproCourseSnapshot) => {
  if (typeof window === 'undefined' || !snapshot.latestShotKey) return
  const watermark: ShotDeliveryWatermark = {
    key: snapshot.latestShotKey,
    roundSignature: snapshot.health.currentRound.signature,
    deliveredAt: new Date().toISOString(),
  }
  try {
    window.localStorage.setItem(SHOT_WATERMARK_STORAGE_KEY, JSON.stringify(watermark))
  } catch {
    // A hardened/private browser may block storage. Live delivery still works for this mount.
  }
}

const hasInitialHealth = (snapshot: BrowserGsproCourseSnapshot) =>
  snapshot.health.currentRound.signature != null
  || snapshot.health.currentRound.state === 'invalid'
  || snapshot.health.integrity === 'stale'

export const connectToBrowserGsproCourseState = ({
  onSnapshot,
  onStatusChange,
  onError,
}: {
  onSnapshot: (snapshot: BrowserGsproCourseSnapshot) => void
  onStatusChange?: (status: BrowserGsproCourseStatus) => void
  onError?: (error: unknown) => void
}): BrowserGsproCourseConnection => {
  let disconnected = false
  let initialized = false
  let pendingInitialSnapshot: BrowserGsproCourseSnapshot | null = null
  let watermark = loadShotWatermark()

  const remember = (snapshot: BrowserGsproCourseSnapshot) => {
    if (!snapshot.latestShotKey) return
    if (
      watermark?.key === snapshot.latestShotKey
      && watermark.roundSignature === snapshot.health.currentRound.signature
    ) return
    saveShotWatermark(snapshot)
    watermark = {
      key: snapshot.latestShotKey,
      roundSignature: snapshot.health.currentRound.signature,
      deliveredAt: new Date().toISOString(),
    }
  }

  const deliverInitial = (snapshot: BrowserGsproCourseSnapshot) => {
    if (initialized || disconnected) return
    initialized = true

    const latestKey = snapshot.latestShotKey
    const roundSignature = snapshot.health.currentRound.signature
    const shouldRecoverMissedShot =
      latestKey != null
      && watermark?.key != null
      && latestKey !== watermark.key
      && roundSignature != null
      && roundSignature !== watermark.roundSignature
      && snapshot.health.currentRound.state === 'available'
      && snapshot.health.integrity !== 'stale'

    if (shouldRecoverMissedShot && watermark) {
      // Aim Lab intentionally treats its first shot key as a baseline. Seed that baseline
      // with the last delivered key, then immediately deliver the new GSPro key so a shot
      // hit during a disconnect is handled as a real transition instead of being swallowed.
      onSnapshot({
        ...snapshot,
        latestShot: null,
        latestShotKey: watermark.key,
        warnings: [
          ...snapshot.warnings,
          'Recovered a new GSPro shot written while Looper was disconnected.',
        ],
      })
    }

    onSnapshot(snapshot)
    remember(snapshot)
  }

  const initialTimer = window.setTimeout(() => {
    if (pendingInitialSnapshot) deliverInitial(pendingInitialSnapshot)
  }, INITIAL_HEALTH_GRACE_MS)

  const connection = connectReliableGsproCourseState({
    onStatusChange,
    onError,
    onSnapshot: (snapshot) => {
      if (disconnected) return

      if (!initialized) {
        pendingInitialSnapshot = snapshot
        if (hasInitialHealth(snapshot)) {
          window.clearTimeout(initialTimer)
          deliverInitial(snapshot)
        }
        return
      }

      onSnapshot(snapshot)
      remember(snapshot)
    },
  })

  return {
    disconnect: () => {
      if (disconnected) return
      disconnected = true
      window.clearTimeout(initialTimer)
      connection.disconnect()
    },
  }
}
