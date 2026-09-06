import { useEffect, useMemo, useRef, useState } from 'react'
import { getClubDisplayName } from '../lib/bagConfig'
import {
  type HumanShotJudgment,
  loadHumanShotReviews,
  updateHumanShotReview,
} from '../lib/shotReview'
import { loadActiveSessionDraft } from '../lib/sessions'
import type { Shot } from '../types'
import './ShotReviewPanel.css'

const JUDGMENT_OPTIONS: Array<{
  value: HumanShotJudgment
  label: string
  shortcut: string
}> = [
  { value: 'normal', label: 'Normal', shortcut: 'N' },
  { value: 'mishit', label: 'Mishit', shortcut: 'M' },
  { value: 'severe_mishit', label: 'Severe', shortcut: 'S' },
  { value: 'intentional', label: 'Intentional', shortcut: 'I' },
  { value: 'unsure', label: 'Unsure', shortcut: 'U' },
]

const formatYards = (value: number | undefined) =>
  typeof value === 'number' ? `${Math.round(value)} yd` : '—'

const formatBallSpeed = (shot: Shot) => {
  if (typeof shot.ballSpeedMph === 'number') {
    return `${Math.round(shot.ballSpeedMph)} mph`
  }
  if (typeof shot.ballSpeedMetersPerSecond === 'number') {
    return `${Math.round(shot.ballSpeedMetersPerSecond * 2.23694)} mph`
  }
  return '—'
}

const formatOffline = (value: number | undefined) => {
  if (typeof value !== 'number') {
    return '—'
  }
  if (Math.abs(value) < 0.5) {
    return 'Center'
  }
  return `${Math.round(Math.abs(value))} yd ${value < 0 ? 'L' : 'R'}`
}

function ShotReviewPanel() {
  const [draft, setDraft] = useState(() => loadActiveSessionDraft())
  const [reviews, setReviews] = useState(() => loadHumanShotReviews())
  const [isOpen, setIsOpen] = useState(false)
  const [selectedShotId, setSelectedShotId] = useState<string | null>(() => {
    const initialShots = loadActiveSessionDraft()?.shots ?? []
    return initialShots[initialShots.length - 1]?.id ?? null
  })
  const previousLatestShotId = useRef<string | null>(selectedShotId)

  useEffect(() => {
    const syncDraft = () => setDraft(loadActiveSessionDraft())
    syncDraft()
    const timer = window.setInterval(syncDraft, 750)
    return () => window.clearInterval(timer)
  }, [])

  const shots = draft?.shots ?? []
  const latestShotId = shots[shots.length - 1]?.id ?? null

  useEffect(() => {
    if (latestShotId && latestShotId !== previousLatestShotId.current) {
      previousLatestShotId.current = latestShotId
      setSelectedShotId(latestShotId)
    }
    if (!latestShotId) {
      previousLatestShotId.current = null
      setSelectedShotId(null)
    }
  }, [latestShotId])

  const selectedIndex = useMemo(
    () => shots.findIndex((shot) => shot.id === selectedShotId),
    [selectedShotId, shots],
  )
  const selectedShot = selectedIndex >= 0 ? shots[selectedIndex] : null
  const selectedReview = selectedShot ? reviews[selectedShot.id] : undefined
  const labeledCount = shots.filter((shot) => Boolean(reviews[shot.id]?.judgment)).length

  const applyReview = (
    shotId: string,
    patch: {
      judgment?: HumanShotJudgment | null
      note?: string | null
    },
  ) => {
    const next = updateHumanShotReview(shotId, {
      ...patch,
      sessionId: draft?.id,
    })
    setReviews(next)
  }

  useEffect(() => {
    if (!isOpen || !selectedShot) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName?.toLowerCase()
      if (
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        target?.isContentEditable
      ) {
        return
      }

      const key = event.key.toLowerCase()
      const option = JUDGMENT_OPTIONS.find(
        (candidate) => candidate.shortcut.toLowerCase() === key,
      )
      if (!option) {
        return
      }

      event.preventDefault()
      const next = updateHumanShotReview(selectedShot.id, {
        sessionId: draft?.id,
        judgment: option.value,
      })
      setReviews(next)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft?.id, isOpen, selectedShot])

  const selectRelativeShot = (direction: -1 | 1) => {
    const nextIndex = selectedIndex + direction
    if (nextIndex >= 0 && nextIndex < shots.length) {
      setSelectedShotId(shots[nextIndex].id)
    }
  }

  if (!isOpen) {
    return (
      <button
        className="shot-review-launcher"
        onClick={() => setIsOpen(true)}
        type="button"
      >
        <span>Review shots</span>
        {shots.length > 0 ? (
          <strong>
            {labeledCount}/{shots.length}
          </strong>
        ) : null}
      </button>
    )
  }

  return (
    <aside className="shot-review-panel" aria-label="Human mishit review">
      <div className="shot-review-header">
        <div>
          <span className="shot-review-eyebrow">Human review</span>
          <h2>Mishit labels</h2>
        </div>
        <button
          className="shot-review-close"
          onClick={() => setIsOpen(false)}
          type="button"
          aria-label="Close shot review"
        >
          ×
        </button>
      </div>

      {shots.length === 0 || !selectedShot ? (
        <div className="shot-review-empty">
          Hit a shot in Session Intelligence and it will appear here automatically.
        </div>
      ) : (
        <>
          <div className="shot-review-progress">
            <button
              onClick={() => selectRelativeShot(-1)}
              disabled={selectedIndex <= 0}
              type="button"
            >
              ←
            </button>
            <span>
              Shot {selectedIndex + 1} of {shots.length} · {labeledCount} labeled
            </span>
            <button
              onClick={() => selectRelativeShot(1)}
              disabled={selectedIndex >= shots.length - 1}
              type="button"
            >
              →
            </button>
            <button
              className="shot-review-latest"
              onClick={() => setSelectedShotId(latestShotId)}
              disabled={selectedShot.id === latestShotId}
              type="button"
            >
              Latest
            </button>
          </div>

          <div className="shot-review-shot-card">
            <div className="shot-review-shot-title">
              <strong>{getClubDisplayName(selectedShot.club)}</strong>
              <span>{new Date(selectedShot.capturedAt).toLocaleTimeString()}</span>
            </div>
            <div className="shot-review-metrics">
              <div>
                <span>Carry</span>
                <strong>{formatYards(selectedShot.carryYards)}</strong>
              </div>
              <div>
                <span>Offline</span>
                <strong>{formatOffline(selectedShot.offlineYards)}</strong>
              </div>
              <div>
                <span>Ball speed</span>
                <strong>{formatBallSpeed(selectedShot)}</strong>
              </div>
            </div>
          </div>

          <div className="shot-review-options" role="group" aria-label="Shot judgment">
            {JUDGMENT_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`shot-review-option shot-review-option-${option.value} ${
                  selectedReview?.judgment === option.value ? 'is-selected' : ''
                }`}
                onClick={() =>
                  applyReview(selectedShot.id, {
                    judgment:
                      selectedReview?.judgment === option.value ? null : option.value,
                  })
                }
                type="button"
                aria-pressed={selectedReview?.judgment === option.value}
              >
                <span>{option.label}</span>
                <kbd>{option.shortcut}</kbd>
              </button>
            ))}
          </div>

          <label className="shot-review-note">
            <span>Optional note</span>
            <textarea
              value={selectedReview?.note ?? ''}
              onChange={(event) =>
                applyReview(selectedShot.id, { note: event.target.value })
              }
              placeholder="e.g. high toe; nearly topped it; bad block but still a real miss"
              rows={3}
            />
          </label>

          <p className="shot-review-footnote">
            Human labels are stored separately from the shot and do not change Stock, Pure,
            inclusion, or the automatic mishit classifier.
          </p>
        </>
      )}
    </aside>
  )
}

export default ShotReviewPanel
