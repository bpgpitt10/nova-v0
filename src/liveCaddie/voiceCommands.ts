// EXPERIMENTAL: voice commands from the companion ("Looper, arm three wood").
// The companion listens on the sim PC's microphone and reports what it heard
// after a wake word; this module polls for those reports. Nothing here acts on
// GSPro: Live Caddie arms the club exactly as the buttons do.

const VOICE_URL = 'http://127.0.0.1:8787/companion/v1/voice'
const POLL_MS = 500
const TIMEOUT_MS = 2500
const VOICE_ENABLED_KEY = 'looper.live-caddie.voice.v1'

const VOICE_ACTIONS = [
  'arm', 'arm-shown', 'arm-recommended', 'clear', 'aim', 'aim-reset', 'club-step', 'wind', 'details', 'gspro', 'confirm',
] as const

export type VoiceCommand = {
  seq: number
  at: number
  heard: string
  /** The recogniser's confidence in its weakest word, 0..1, when it gave one. */
  conf: number | null
  action: typeof VOICE_ACTIONS[number]
  /** arm */
  club: string | null
  /** aim: 'left' | 'right'; club-step: 'up' | 'down' */
  direction?: string
  /** aim */
  yards?: number
  /** gspro: which GSPro view was asked for */
  key?: string
}

/** Below this the command is treated as misheard. Tuned from real rounds. */
export const VOICE_MIN_CONFIDENCE = 0.4

export type VoiceHeard = {
  text: string
  at: number
  command: boolean
  /** The wake word was said on its own; a command may follow. */
  waiting: boolean
  conf: number | null
}

export type VoiceStatus =
  | { state: 'off' }
  | { state: 'starting' }
  /** `level` is the microphone's loudness right now, 0..1. */
  | { state: 'listening'; device: string | null; level: number; lastHeard: VoiceHeard | null }
  | { state: 'unavailable'; reason: string }

type VoicePayload = {
  service?: unknown
  status?: unknown
  reason?: unknown
  latest?: unknown
  events?: unknown
  device?: unknown
  level?: unknown
  lastHeard?: unknown
}

export const loadVoiceEnabled = () => {
  try {
    return window.localStorage.getItem(VOICE_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export const saveVoiceEnabled = (enabled: boolean) => {
  try {
    if (enabled) window.localStorage.setItem(VOICE_ENABLED_KEY, '1')
    else window.localStorage.removeItem(VOICE_ENABLED_KEY)
  } catch {
    // the switch still works for this page load
  }
}

/** Plain words for why the microphone isn't listening. */
export const voiceReasonText = (reason: string) => {
  if (reason === 'no-microphone') return 'No microphone found on this PC.'
  if (reason === 'no-model' || reason.startsWith('no-engine')) return 'This companion build has no voice support.'
  if (reason === 'companion') return 'The companion is not answering.'
  return `Voice is not available (${reason}).`
}

const isCommand = (value: unknown): value is VoiceCommand => {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return typeof event.seq === 'number'
    && (VOICE_ACTIONS as readonly unknown[]).includes(event.action)
    && (event.club == null || typeof event.club === 'string')
}

const readVoice = async (since: number | null, clubs: string[]): Promise<VoicePayload> => {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    // The bag goes along so only clubs the player carries can be heard.
    const bag = `&clubs=${encodeURIComponent(clubs.join(','))}`
    const url = since == null ? `${VOICE_URL}?listen=1${bag}` : `${VOICE_URL}?listen=1&since=${since}${bag}`
    const response = await fetch(new Request(url, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
      targetAddressSpace: 'loopback',
    } as RequestInit & { targetAddressSpace: 'loopback' }))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as VoicePayload
  } finally {
    window.clearTimeout(timeoutId)
  }
}

/**
 * Keep the companion's microphone open and deliver each new command once.
 * Commands heard before this started are never replayed. Returns a stop
 * function; a few seconds after it is called the companion closes the mic.
 */
export const startVoiceCommands = (
  onCommand: (command: VoiceCommand) => void,
  onStatus: (status: VoiceStatus) => void,
  getClubs: () => string[] = () => [],
) => {
  let stopped = false
  let busy = false
  let since: number | null = null
  let failures = 0
  onStatus({ state: 'starting' })

  const poll = async () => {
    if (stopped || busy) return
    busy = true
    try {
      const payload = await readVoice(since, getClubs())
      if (stopped) return
      failures = 0
      if (payload.service !== 'looper-companion') throw new Error('not the companion')
      const latest = typeof payload.latest === 'number' ? payload.latest : null
      if (since == null) {
        since = latest ?? 0
      } else if (Array.isArray(payload.events)) {
        for (const event of payload.events) {
          if (!isCommand(event) || event.seq <= since) continue
          since = event.seq
          onCommand({ ...event, club: event.club ?? null, conf: typeof event.conf === 'number' ? event.conf : null })
        }
      }
      if (payload.status === 'listening') {
        const heard = payload.lastHeard as Partial<VoiceHeard> | null | undefined
        onStatus({
          state: 'listening',
          device: typeof payload.device === 'string' ? payload.device : null,
          level: typeof payload.level === 'number' ? payload.level : 0,
          lastHeard: heard && typeof heard.text === 'string' && typeof heard.at === 'number'
            ? {
              text: heard.text,
              at: heard.at,
              command: heard.command === true,
              waiting: heard.waiting === true,
              conf: typeof heard.conf === 'number' ? heard.conf : null,
            }
            : null,
        })
      }
      else if (payload.status === 'unavailable') {
        onStatus({ state: 'unavailable', reason: typeof payload.reason === 'string' ? payload.reason : 'unknown' })
      } else onStatus({ state: 'starting' })
    } catch {
      failures += 1
      if (!stopped && failures >= 4) onStatus({ state: 'unavailable', reason: 'companion' })
    } finally {
      busy = false
    }
  }

  void poll()
  const timer = window.setInterval(() => { void poll() }, POLL_MS)
  return () => {
    stopped = true
    window.clearInterval(timer)
    onStatus({ state: 'off' })
  }
}

const GSPRO_KEY_URL = 'http://127.0.0.1:8787/companion/v1/gspro-key'

/** What each GSPro shortcut is called on screen. */
export const GSPRO_VIEW_LABELS: Record<string, string> = {
  flyover: 'Flyover',
  scorecard: 'Scorecard',
  heatmap: 'Heat map',
  greengrid: 'Green grid',
  shotcam: 'Shot cam',
  pin: 'Pin indicator',
  putt: 'Putt mode',
  hideui: 'Hide UI',
  mulligan: 'Mulligan',
}

/** Shortcuts that change the round: asked for twice ("Looper, confirm"). */
export const GSPRO_KEYS_NEEDING_CONFIRM = new Set(['mulligan'])

export const gsproKeyReasonText = (reason: string | undefined) => {
  if (reason === 'gspro-not-connected') return 'GSPro is not open'
  if (reason === 'gspro-minimized') return 'GSPro is minimized'
  if (reason === 'gspro-not-in-front') return "Couldn't bring GSPro to the front"
  if (reason === 'too-soon') return 'Too fast: say it again'
  if (reason === 'unknown-key') return 'This companion build does not know that view'
  return 'The companion could not press that key'
}

/**
 * Ask the companion to press one named GSPro shortcut. The companion only
 * accepts names from its own fixed list and presses nothing unless GSPro is
 * the window in front.
 */
export const pressGsproKey = async (key: string): Promise<{ status: 'sent' | 'blocked'; reason?: string }> => {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(new Request(GSPRO_KEY_URL, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Looper-Intent': 'gspro-key' },
      body: JSON.stringify({ key }),
      targetAddressSpace: 'loopback',
    } as RequestInit & { targetAddressSpace: 'loopback' }))
    if (!response.ok) return { status: 'blocked', reason: `http-${response.status}` }
    const data = await response.json() as { status?: unknown; reason?: unknown }
    return data.status === 'sent'
      ? { status: 'sent' }
      : { status: 'blocked', reason: typeof data.reason === 'string' ? data.reason : undefined }
  } catch {
    return { status: 'blocked', reason: 'companion' }
  } finally {
    window.clearTimeout(timeoutId)
  }
}
