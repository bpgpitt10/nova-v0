import { useCallback, useEffect, useState } from 'react'
import { GSPRO_PLAYER_EVENT, chooseMyGsproPlayer, knownGsproPlayers } from '../lib/gsproPlayers'

type Known = Awaited<ReturnType<typeof knownGsproPlayers>>

/** The GSPro players this account knows, kept fresh when a claim changes anywhere on the page. */
export const useKnownGsproPlayers = (signedIn: boolean) => {
  const [players, setPlayers] = useState<Known | null>(null)
  const refresh = useCallback(async () => {
    setPlayers(await knownGsproPlayers().catch(() => null))
  }, [])
  useEffect(() => {
    if (!signedIn) { setPlayers(null); return }
    void refresh()
    const onChange = () => { void refresh() }
    window.addEventListener(GSPRO_PLAYER_EVENT, onChange)
    return () => window.removeEventListener(GSPRO_PLAYER_EVENT, onChange)
  }, [refresh, signedIn])
  return players
}

/**
 * Account menu: "GSPro player: Brian · Change". Change lists every player this account has seen
 * in a GSPro round; picking one keeps only that player's shots from then on (Brian, 21 Nov).
 */
export function AccountGsproPlayer({ players }: { players: Known | null }) {
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mine = (players ?? []).filter((player) => player.mine)
  const choose = async (key: string) => {
    setBusy(true)
    setError(null)
    try {
      await chooseMyGsproPlayer(key)
      setChoosing(false)
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : String(chooseError))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="looper-account-control__player">
      <span className="looper-account-control__label">GSPro player</span>
      {mine.length ? (
        <div className="looper-account-control__player-row">
          <strong>{mine.map((player) => player.name ?? 'Unnamed player').join(', ')}</strong>
          {(players ?? []).length > 1 ? (
            <button type="button" className="looper-account-control__link" onClick={() => setChoosing(!choosing)}>
              {choosing ? 'Cancel' : 'Change'}
            </button>
          ) : null}
        </div>
      ) : (
        <span className="looper-account-control__hint">Not set yet: play a round and Looper will ask.</span>
      )}
      {choosing ? (
        <div className="looper-account-control__choices">
          {(players ?? []).map((player) => (
            <button key={player.key} type="button" disabled={busy || player.mine} onClick={() => void choose(player.key)}>
              {player.name ?? 'Unnamed player'}{player.mine ? ' · you' : ''}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <div className="looper-account-control__error">{error}</div> : null}
    </div>
  )
}
