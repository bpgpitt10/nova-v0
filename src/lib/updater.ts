// Looper is web-only. The old desktop (Tauri) auto-updater is gone; the hosted
// site updates on deploy. This keeps the app's update-status plumbing intact
// and always reports that in-app updates are unavailable.

export type LooperUpdate = {
  downloadAndInstall: () => Promise<void>
}

export type LooperUpdateCheckResult =
  | { status: 'unavailable' }
  | { status: 'up-to-date' }
  | { status: 'available'; update: LooperUpdate }

export const checkForLooperUpdate = async (): Promise<LooperUpdateCheckResult> => ({
  status: 'unavailable',
})
