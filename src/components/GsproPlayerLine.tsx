import { useCallback, useEffect, useState } from 'react'
import { GSPRO_PLAYER_EVENT, myGsproPlayerNames, resetPlayerClaims } from '../lib/gsproPlayers'

/** "Your GSPro player: Brian · Not you?" Only that player's shots are saved to this account. */
export default function GsproPlayerLine() {
  const [names, setNames] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setNames(await myGsproPlayerNames().catch(() => null))
  }, [])

  useEffect(() => {
    void refresh()
    const onChange = () => { void refresh() }
    window.addEventListener(GSPRO_PLAYER_EVENT, onChange)
    return () => window.removeEventListener(GSPRO_PLAYER_EVENT, onChange)
  }, [refresh])

  if (!names || names.length === 0) return null
  const reset = async () => {
    setBusy(true)
    try {
      await resetPlayerClaims()
    } finally {
      setBusy(false)
    }
  }
  return (
    <p className="rounds-muted rounds-small">
      Your GSPro player: <strong>{names.join(', ')}</strong>. Only {names.length === 1 ? 'that player’s' : 'their'} shots are saved here.{' '}
      <button type="button" className="rounds-link-button" disabled={busy} onClick={() => void reset()}>
        Not you?
      </button>
    </p>
  )
}
