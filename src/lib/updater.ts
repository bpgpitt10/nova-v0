export type LooperUpdate = {
  version?: string
  downloadAndInstall: () => Promise<void>
}

export type LooperUpdateCheckResult =
  | { status: 'unavailable' }
  | { status: 'up-to-date' }
  | { status: 'available'; update: LooperUpdate }

// The browser-delivered Looper app is updated by deploying the web app. There
// is no native installer/updater lifecycle in the client.
export const checkForLooperUpdate = async (): Promise<LooperUpdateCheckResult> =>
  ({ status: 'unavailable' })
