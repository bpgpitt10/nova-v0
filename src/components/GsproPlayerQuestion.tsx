import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentLooperUser } from '../cloud/supabaseClient'
import {
  GSPRO_PLAYER_EVENT,
  answerPlayerQuestion,
  loadPlayerQuestions,
  type PlayerQuestion,
} from '../lib/gsproPlayers'
import './GsproPlayerQuestion.css'

/** How long a new question waits before it shows, in case another round answers it first. */
const QUESTION_SETTLE_MS = 4000

/**
 * "Which one is you?": a GSPro round with more than one player (or a player this
 * account hasn't seen) waits here until the player answers. Only the answer's
 * shots are saved to this account. Fixed in the corner, so no page moves.
 */
export default function GsproPlayerQuestion() {
  const [question, setQuestion] = useState<PlayerQuestion | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const user = await getCurrentLooperUser().catch(() => null)
    const latest = user ? loadPlayerQuestions(user.id).at(-1) ?? null : null
    // Rounds are sorted out one after another: a solo round a moment later can answer this one
    // (21 Nov: the question flashed and closed). Show it only once it has waited a few seconds.
    const waited = latest ? Date.now() - Date.parse(latest.askedAt) : 0
    if (latest && waited < QUESTION_SETTLE_MS) {
      setQuestion(null)
      window.setTimeout(() => { void refreshRef.current() }, QUESTION_SETTLE_MS - waited + 50)
      return
    }
    setQuestion(latest)
  }, [])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    void refresh()
    const onChange = () => { void refresh() }
    window.addEventListener(GSPRO_PLAYER_EVENT, onChange)
    window.addEventListener('storage', onChange)
    const timer = window.setInterval(onChange, 15_000)
    return () => {
      window.removeEventListener(GSPRO_PLAYER_EVENT, onChange)
      window.removeEventListener('storage', onChange)
      window.clearInterval(timer)
    }
  }, [refresh])

  if (!question) return null

  const answer = async (playerKey: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await answerPlayerQuestion(question.roundId, playerKey)
      await refresh()
    } catch (answerError) {
      setError(answerError instanceof Error ? answerError.message : String(answerError))
    } finally {
      setBusy(false)
    }
  }

  const several = question.players.length > 1
  return (
    <section className="gspro-player-question" role="dialog" aria-labelledby="gspro-player-question-title">
      <div className="gspro-player-question__text">
        <strong id="gspro-player-question-title">{several ? 'Which one is you?' : 'Is this you?'}</strong>
        <span>
          {several
            ? `Your GSPro round${question.courseKey ? ` at ${question.courseKey}` : ''} has ${question.players.length} players. Looper saves only your shots.`
            : `This GSPro round${question.courseKey ? ` at ${question.courseKey}` : ''} was played as someone Looper hasn't seen on your account.`}
        </span>
        {error ? <span className="gspro-player-question__error">{error}</span> : null}
      </div>
      <div className="gspro-player-question__actions">
        {question.players.map((player) => (
          <button key={player.key} type="button" disabled={busy} onClick={() => void answer(player.key)}>
            {several ? (player.name ?? 'Unnamed player') : `Yes, I'm ${player.name ?? 'this player'}`}
            <small>{player.shots} {player.shots === 1 ? 'shot' : 'shots'}</small>
          </button>
        ))}
        <button type="button" className="is-quiet" disabled={busy} onClick={() => void answer(null)}>
          {several ? 'None of these' : 'Not me'}
        </button>
      </div>
    </section>
  )
}
