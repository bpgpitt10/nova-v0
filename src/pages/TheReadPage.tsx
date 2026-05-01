import { useRef, useState } from 'react'
import './TheReadPage.css'

const LADDER_MIN_YARDAGE = 30
const LADDER_MAX_YARDAGE = 320
const BASE_TICK_SPACING = 72
const SHOT_MARKER_VERTICAL_SPACE = 44
const WHEEL_STEP_THRESHOLD = 110

const shotMarkers = [
  { label: 'Driver Stock', tone: 'strong', yardage: 270 },
  { label: '7i Stock', tone: 'safe', yardage: 165 },
  { label: 'SW Soft', tone: 'soft', yardage: 85 },
]

const ladderMarks = Array.from(
  { length: (LADDER_MAX_YARDAGE - LADDER_MIN_YARDAGE) / 10 + 1 },
  (_, index) => LADDER_MIN_YARDAGE + index * 10,
)

const maxShotMarkersInTenYardGap = Math.max(
  1,
  ...ladderMarks.map(
    (yardage) =>
      shotMarkers.filter((marker) => marker.yardage >= yardage && marker.yardage < yardage + 10)
        .length,
  ),
)
const LADDER_TICK_SPACING = Math.max(
  BASE_TICK_SPACING,
  maxShotMarkersInTenYardGap * SHOT_MARKER_VERTICAL_SPACE + 20,
)

const readOptions = [
  {
    label: 'Short',
    club: 'SW Soft',
    score: '91 (Play)',
    stock: {
      left: '34%',
      top: '54%',
      width: '86px',
      height: '46px',
      rotate: '-10deg',
      carry: 94,
      total: 97,
    },
    pure: {
      left: '40%',
      top: '45%',
      width: '58px',
      height: '32px',
      rotate: '-6deg',
      carry: 98,
      total: 100,
    },
  },
  {
    label: 'Best',
    club: 'GW Flighted',
    score: '91 (Play)',
    stock: {
      left: '30%',
      top: '38%',
      width: '102px',
      height: '40px',
      rotate: '7deg',
      carry: 101,
      total: 104,
    },
    pure: {
      left: '42%',
      top: '42%',
      width: '60px',
      height: '28px',
      rotate: '4deg',
      carry: 100,
      total: 102,
    },
  },
  {
    label: 'Long',
    club: 'PW Stock',
    score: '91 (Play)',
    stock: {
      left: '40%',
      top: '28%',
      width: '78px',
      height: '58px',
      rotate: '14deg',
      carry: 108,
      total: 112,
    },
    pure: {
      left: '34%',
      top: '36%',
      width: '54px',
      height: '36px',
      rotate: '8deg',
      carry: 105,
      total: 109,
    },
  },
]

const yardageToOffset = (yardage: number) =>
  ((yardage - LADDER_MIN_YARDAGE) / 10) * LADDER_TICK_SPACING

const clampYardage = (yardage: number) =>
  Math.min(LADDER_MAX_YARDAGE, Math.max(LADDER_MIN_YARDAGE, yardage))

export default function TheReadPage() {
  const [distanceMode, setDistanceMode] = useState<'carry' | 'total'>('carry')
  const [selectedTargetYardage, setSelectedTargetYardage] = useState(100)
  const wheelDeltaRef = useRef(0)
  const selectedYardageOffset = yardageToOffset(selectedTargetYardage)
  const selectYardage = (yardage: number) => setSelectedTargetYardage(clampYardage(yardage))
  const scrollLadder = (deltaY: number) => {
    wheelDeltaRef.current += deltaY
    if (Math.abs(wheelDeltaRef.current) < WHEEL_STEP_THRESHOLD) {
      return
    }
    const direction = wheelDeltaRef.current > 0 ? 1 : -1
    wheelDeltaRef.current = 0
    setSelectedTargetYardage((yardage) => clampYardage(yardage + direction * 10))
  }
  const formatDotValue = (option: (typeof readOptions)[number]['stock']) =>
    `${distanceMode === 'carry' ? option.carry : option.total}`

  return (
    <main className="the-read-page">
      <div className="the-read-shell">
        <header className="the-read-header">
          <div>
            <h1>The Read</h1>
            <p>Pick a yardage. The Looper will find the shot you can trust.</p>
          </div>
          <div className="the-read-toggle" aria-label="Distance mode">
            <button
              className={distanceMode === 'carry' ? 'is-active' : undefined}
              onClick={() => setDistanceMode('carry')}
              type="button"
            >
              Carry
            </button>
            <button
              className={distanceMode === 'total' ? 'is-active' : undefined}
              onClick={() => setDistanceMode('total')}
              type="button"
            >
              Total
            </button>
          </div>
        </header>

        <section className="the-read-layout" aria-label="The Read workspace">
          <div className="the-read-ladder-card">
            <div
              className="the-read-ladder"
              onWheel={(event) => {
                event.preventDefault()
                scrollLadder(event.deltaY)
              }}
            >
              <div className="the-read-ladder-target" />
              <div
                className="the-read-ladder-tape"
                style={{
                  height: `${(ladderMarks.length - 1) * LADDER_TICK_SPACING}px`,
                  transform: `translateY(-${selectedYardageOffset}px)`,
                }}
              >
                {ladderMarks.map((yardage) => (
                  <button
                    className={
                      yardage === selectedTargetYardage
                        ? 'the-read-yardage-tick is-selected'
                        : 'the-read-yardage-tick'
                    }
                    key={yardage}
                    onClick={() => selectYardage(yardage)}
                    style={{ top: `${yardageToOffset(yardage)}px` }}
                    type="button"
                  >
                    <span>{yardage}</span>
                  </button>
                ))}
                {shotMarkers.map((marker) => (
                  <button
                    className={`the-read-shot-marker the-read-shot-marker-${marker.tone}`}
                    key={marker.label}
                    onClick={() => selectYardage(marker.yardage)}
                    style={{ top: `${yardageToOffset(marker.yardage)}px` }}
                    type="button"
                  >
                    {marker.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <aside className="the-read-decision-panel" aria-label="Decision panel">
            <div className="the-read-card the-read-looper-card">
              <span className="the-read-eyebrow">Looper Read</span>
              <p>Select a yardage to get the call.</p>
            </div>

            <div className="the-read-dispersion-panel">
              <div className="the-read-target-line">
                <span>{selectedTargetYardage} yd target</span>
              </div>
              {readOptions.map((option) => (
                <article className="the-read-dispersion-column" key={option.label}>
                  <div className="the-read-dispersion-head">
                    <span>{option.label}</span>
                    <strong>{option.club}</strong>
                    <p>{option.score}</p>
                  </div>
                  <div className="the-read-dispersion-plot" aria-hidden="true">
                    <span
                      className="the-read-ellipse the-read-ellipse-stock"
                      style={{
                        left: option.stock.left,
                        top: option.stock.top,
                        width: option.stock.width,
                        height: option.stock.height,
                        transform: `rotate(${option.stock.rotate})`,
                      }}
                    >
                      <span className="the-read-ellipse-dot">
                        {formatDotValue(option.stock)}
                      </span>
                    </span>
                    <span
                      className="the-read-ellipse the-read-ellipse-pure"
                      style={{
                        left: option.pure.left,
                        top: option.pure.top,
                        width: option.pure.width,
                        height: option.pure.height,
                        transform: `rotate(${option.pure.rotate})`,
                      }}
                    >
                      <span className="the-read-ellipse-dot">
                        {formatDotValue(option.pure)}
                      </span>
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </aside>
        </section>
      </div>
    </main>
  )
}
