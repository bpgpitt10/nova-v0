import { useRef, useState } from 'react'
import './TheReadPage.css'

const LADDER_MIN_YARDAGE = 30
const LADDER_MAX_YARDAGE = 320
const BASE_TICK_SPACING = 72
const SHOT_MARKER_VERTICAL_SPACE = 44
const WHEEL_STEP_THRESHOLD = 110
type ShotMode = 'stock' | 'pure'

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
      stats: {
        carry: ['94 yd', '-6'],
        total: ['97 yd', '-5'],
        offline: ['5.8 L', '-1.4'],
        launch: ['31.2°', '+2.1'],
        hla: ['1.8 L', '-0.5'],
        spin: ['8420', '+340'],
        spinAxis: ['6.4 L', '-1.1'],
        smash: ['1.19', '-0.02'],
        ballSpeed: ['78 mph', '-3'],
        clubSpeed: ['65 mph', '-1'],
        peak: ['72 ft', '+5'],
        descent: ['47°', '+3'],
        clubPath: ['1.2 R', '+0.4'],
        faceToPath: ['0.8 L', '-0.2'],
        faceToTarget: ['1.9 L', '-0.4'],
        ogcShotName: ['Soft wedge', ''],
        ogcRank: ['A-', '+4'],
      },
    },
    pure: {
      left: '40%',
      top: '45%',
      width: '58px',
      height: '32px',
      rotate: '-6deg',
      carry: 98,
      total: 100,
      stats: {
        carry: ['98 yd', '-2'],
        total: ['100 yd', '-2'],
        offline: ['2.1 L', '+2.3'],
        launch: ['30.4°', '+1.3'],
        hla: ['0.7 L', '+0.6'],
        spin: ['8160', '+80'],
        spinAxis: ['2.0 L', '+3.3'],
        smash: ['1.21', '0.00'],
        ballSpeed: ['80 mph', '-1'],
        clubSpeed: ['66 mph', '0'],
        peak: ['69 ft', '+2'],
        descent: ['45°', '+1'],
        clubPath: ['0.6 R', '-0.2'],
        faceToPath: ['0.2 L', '+0.4'],
        faceToTarget: ['0.6 L', '+0.9'],
        ogcShotName: ['Soft wedge', ''],
        ogcRank: ['A', '+7'],
      },
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
      stats: {
        carry: ['101 yd', '+1'],
        total: ['104 yd', '+2'],
        offline: ['3.0 R', '+1.2'],
        launch: ['27.8°', '+0.4'],
        hla: ['0.9 R', '+0.2'],
        spin: ['7620', '-120'],
        spinAxis: ['3.8 R', '+0.7'],
        smash: ['1.24', '+0.01'],
        ballSpeed: ['86 mph', '+1'],
        clubSpeed: ['69 mph', '0'],
        peak: ['74 ft', '+3'],
        descent: ['44°', '+1'],
        clubPath: ['1.7 R', '+0.5'],
        faceToPath: ['0.3 L', '+0.3'],
        faceToTarget: ['0.5 R', '+0.5'],
        ogcShotName: ['Flighted gap', ''],
        ogcRank: ['A', '+8'],
      },
    },
    pure: {
      left: '42%',
      top: '42%',
      width: '60px',
      height: '28px',
      rotate: '4deg',
      carry: 100,
      total: 102,
      stats: {
        carry: ['100 yd', '0'],
        total: ['102 yd', '0'],
        offline: ['0.8 R', '+3.4'],
        launch: ['27.1°', '-0.3'],
        hla: ['0.2 R', '+0.9'],
        spin: ['7710', '-30'],
        spinAxis: ['1.1 R', '+3.4'],
        smash: ['1.25', '+0.02'],
        ballSpeed: ['87 mph', '+2'],
        clubSpeed: ['69 mph', '0'],
        peak: ['71 ft', '0'],
        descent: ['43°', '0'],
        clubPath: ['1.1 R', '-0.1'],
        faceToPath: ['0.1 R', '+0.7'],
        faceToTarget: ['0.3 R', '+0.7'],
        ogcShotName: ['Flighted gap', ''],
        ogcRank: ['A+', '+11'],
      },
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
      stats: {
        carry: ['108 yd', '+8'],
        total: ['112 yd', '+10'],
        offline: ['6.4 R', '-1.8'],
        launch: ['25.0°', '-2.0'],
        hla: ['2.2 R', '-0.8'],
        spin: ['6880', '-520'],
        spinAxis: ['7.2 R', '-2.0'],
        smash: ['1.28', '+0.03'],
        ballSpeed: ['92 mph', '+5'],
        clubSpeed: ['72 mph', '+2'],
        peak: ['67 ft', '-4'],
        descent: ['40°', '-3'],
        clubPath: ['2.4 R', '+1.2'],
        faceToPath: ['0.9 R', '-0.2'],
        faceToTarget: ['2.8 R', '-1.1'],
        ogcShotName: ['Stock wedge', ''],
        ogcRank: ['B+', '-2'],
      },
    },
    pure: {
      left: '34%',
      top: '36%',
      width: '54px',
      height: '36px',
      rotate: '8deg',
      carry: 105,
      total: 109,
      stats: {
        carry: ['105 yd', '+5'],
        total: ['109 yd', '+7'],
        offline: ['2.6 R', '+2.0'],
        launch: ['25.8°', '-1.2'],
        hla: ['0.8 R', '+0.6'],
        spin: ['7100', '-300'],
        spinAxis: ['2.4 R', '+2.8'],
        smash: ['1.27', '+0.02'],
        ballSpeed: ['91 mph', '+4'],
        clubSpeed: ['72 mph', '+2'],
        peak: ['69 ft', '-2'],
        descent: ['41°', '-2'],
        clubPath: ['1.8 R', '+0.6'],
        faceToPath: ['0.2 R', '+0.5'],
        faceToTarget: ['1.0 R', '+0.7'],
        ogcShotName: ['Stock wedge', ''],
        ogcRank: ['A-', '+3'],
      },
    },
  },
]

const shotMarkers = [
  { label: 'PW Stock', optionLabel: 'Long', tone: 'strong', yardage: 108 },
  { label: 'GW Flighted', optionLabel: 'Best', tone: 'safe', yardage: 100 },
  { label: 'SW Soft', optionLabel: 'Short', tone: 'soft', yardage: 94 },
]

const inspectorRows = [
  ['Carry', 'carry'],
  ['Total Distance', 'total'],
  ['Offline', 'offline'],
  ['Launch / VLA', 'launch'],
  ['Start Line / HLA', 'hla'],
  ['Spin', 'spin'],
  ['Spin Axis', 'spinAxis'],
  ['Smash Factor', 'smash'],
  ['Ball Speed', 'ballSpeed'],
  ['Club Speed', 'clubSpeed'],
  ['Peak Height', 'peak'],
  ['Descent Angle', 'descent'],
  ['Club Path', 'clubPath'],
  ['Face to Path', 'faceToPath'],
  ['Face to Target', 'faceToTarget'],
  ['Score / Call', 'score'],
  ['OGC Shot Name', 'ogcShotName'],
  ['OGC Rank', 'ogcRank'],
] as const

const yardageToOffset = (yardage: number) =>
  ((yardage - LADDER_MIN_YARDAGE) / 10) * LADDER_TICK_SPACING

const clampYardage = (yardage: number) =>
  Math.min(LADDER_MAX_YARDAGE, Math.max(LADDER_MIN_YARDAGE, yardage))

export default function TheReadPage() {
  const [distanceMode, setDistanceMode] = useState<'carry' | 'total'>('carry')
  const [selectedTargetYardage, setSelectedTargetYardage] = useState(100)
  const [selectedOptionLabel, setSelectedOptionLabel] = useState('Best')
  const [selectedMode, setSelectedMode] = useState<ShotMode>('stock')
  const wheelDeltaRef = useRef(0)
  const selectedOption =
    readOptions.find((option) => option.label === selectedOptionLabel) ?? readOptions[1]
  const selectedShot = selectedOption[selectedMode]
  const selectedYardageOffset = yardageToOffset(selectedTargetYardage)
  const selectYardage = (yardage: number) => setSelectedTargetYardage(clampYardage(yardage))
  const selectShot = (optionLabel: string, mode: ShotMode = 'stock') => {
    setSelectedOptionLabel(optionLabel)
    setSelectedMode(mode)
  }
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
                    onClick={() => {
                      selectYardage(marker.yardage)
                      selectShot(marker.optionLabel)
                    }}
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
                  <div className="the-read-dispersion-plot">
                    <button
                      className={
                        selectedOptionLabel === option.label && selectedMode === 'stock'
                          ? 'the-read-ellipse the-read-ellipse-stock is-selected'
                          : 'the-read-ellipse the-read-ellipse-stock'
                      }
                      onClick={() => selectShot(option.label, 'stock')}
                      style={{
                        left: option.stock.left,
                        top: option.stock.top,
                        width: option.stock.width,
                        height: option.stock.height,
                        transform: `rotate(${option.stock.rotate})`,
                      }}
                      type="button"
                    >
                      <span className="the-read-ellipse-dot">
                        {formatDotValue(option.stock)}
                      </span>
                    </button>
                    <button
                      className={
                        selectedOptionLabel === option.label && selectedMode === 'pure'
                          ? 'the-read-ellipse the-read-ellipse-pure is-selected'
                          : 'the-read-ellipse the-read-ellipse-pure'
                      }
                      onClick={() => selectShot(option.label, 'pure')}
                      style={{
                        left: option.pure.left,
                        top: option.pure.top,
                        width: option.pure.width,
                        height: option.pure.height,
                        transform: `rotate(${option.pure.rotate})`,
                      }}
                      type="button"
                    >
                      <span className="the-read-ellipse-dot">
                        {formatDotValue(option.pure)}
                      </span>
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <aside className="the-read-inspector" aria-label="Selected shot details">
              <div className="the-read-inspector-head">
                <span>{selectedMode === 'stock' ? 'Stock' : 'Pure'}</span>
                <strong>{selectedOption.club}</strong>
              </div>
              <div className="the-read-inspector-rows">
                {inspectorRows.map(([label, key]) => {
                  const [value, delta] =
                    key === 'score'
                      ? [selectedOption.score, '']
                      : selectedShot.stats[key]
                  return (
                    <div className="the-read-inspector-row" key={key}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                      <em>{delta}</em>
                    </div>
                  )
                })}
              </div>
            </aside>
          </aside>
        </section>
      </div>
    </main>
  )
}
