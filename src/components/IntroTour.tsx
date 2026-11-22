import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import looperLogo from '../assets/LooperLogo.webp'
import ConditionsMathPanel from '../pages/ConditionsMathPanel'
import ChipOptionsCard from './ChipOptionsCard'
import PuttReadCard from './PuttReadCard'
import { chipOptions, defaultChip, type ChipType } from '../liveCaddie/chipOptions'
import type { ClubAimEvaluation } from '../liveCaddie/aimOptimization'
import { COMPANION_DOWNLOAD_URL, isWindowsBrowser } from '../lib/companionRelease'
import '../pages/LiveCaddiePage.css'
import './IntroTour.css'

/**
 * The intro tour: five cards that show what Looper does, drawn with Looper's own
 * screens and sample shots (no screenshots, so it never goes stale).
 *
 * - visitor: /tour, before signing up (Insights and the sign-in card link here).
 * - new-account: once, right after a new account's first sign-in, before the bag step.
 */

export const INTRO_TOUR_SEEN_KEY = 'looper-intro-tour-seen-v1'
export const SIGN_UP_HREF = '/?signup=1'
// With a query, so the home page shows the sign-in card even where the browser can't remember the tour was seen.
export const SIGN_IN_HREF = '/?signin=1'

export const introTourSeen = (): boolean => {
  try {
    return window.localStorage.getItem(INTRO_TOUR_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

export const markIntroTourSeen = () => {
  try {
    window.localStorage.setItem(INTRO_TOUR_SEEN_KEY, '1')
  } catch {
    // a convenience only: the tour may show once more
  }
}

type Audience = 'visitor' | 'new-account'

type Props = {
  audience: Audience
  /** new-account: close the tour and carry on to the bag step. */
  onDone?: () => void
  /**
   * visitor, shown in place of the sign-in card: leave for that card without a page load.
   * Without it the links go to the home page (the stand-alone /tour).
   */
  onExit?: (to: 'sign-in' | 'sign-up') => void
}

/* ---------- 1. The caddie card: a sample 152-yard approach ---------- */

// The real Expected shot / Why this shot panel, fed a sample 6 iron: into the wind, uphill, from light rough.
const SAMPLE_EVALUATION = {
  club: '6i',
  variant: 'stock',
  stockCarryYds: 164,
  modeledCarryYds: 154.7,
  modeledTotalYds: 158,
  expectedTotalYds: 158,
  lateralBiasYds: 0,
  modeledLateralBiasYds: 1.8,
  windCarryDeltaYds: -4.6,
  windLateralDeltaYds: 1.8,
  airborneCarryDeltaYds: -7.7,
  airborneLateralDeltaYds: 1.8,
  altitudeCarryDeltaYds: 0.4,
  altitudeLateralDeltaYds: 0,
  surfaceCarryDeltaYds: -2,
  surfaceLateralDeltaYds: 0,
  surfaceLabel: 'Light rough: about 2 yd less carry',
  airAltitudeFt: 120,
  greenRelease: { predictedYds: 3, applied: true, conditions: { courseType: 'medium', greenFirmness: 'firm' } },
  fairwayRoll: null,
  bestCandidate: {
    aimOffsetYds: -3,
    riskProfile: {
      success: 0.58,
      manageable: 0.31,
      seriousTrouble: 0.09,
      catastrophe: 0.02,
      unknown: 0,
      bySurface: { green: 0.62, fairway: 0.1, rough: 0.19, bunker: 0.07, water: 0.02 },
    },
  },
} as unknown as ClubAimEvaluation

function CaddieSample() {
  return (
    <div className="intro-tour__caddie">
      <div className="intro-tour__beside" aria-hidden="true">
        <span className="intro-tour__sim">
          <svg viewBox="0 0 120 60" preserveAspectRatio="none">
            <rect width="120" height="60" fill="#5f8fb8" />
            <path d="M0 34 C30 26 70 30 120 24 L120 60 L0 60 Z" fill="#3f6b3a" />
            <path d="M44 60 C52 48 60 40 66 33 L74 33 C76 42 80 52 86 60 Z" fill="#6fa25e" />
            <ellipse cx="70" cy="32" rx="8" ry="2.4" fill="#8cc173" />
            <line x1="71" y1="22" x2="71" y2="32" stroke="#fff" strokeWidth="0.8" />
            <path d="M71 22 L76 23.5 L71 25 Z" fill="#f4d15d" />
          </svg>
          <b>GSPro</b>
        </span>
        <span className="intro-tour__looper">Looper</span>
      </div>
      <article className="intro-tour__decision">
        <div className="live-decision-label-row">
          <span className="live-recommended-pill">RECOMMENDED · #1 CLUB</span>
        </div>
        <div className="live-club-hero">6i</div>
        <div className="live-aim-hero">3 yd left of the pin</div>
        <p className="live-decision-reason">152 to the pin, into the wind and uphill: it plays 9 yd longer. Short right is sand, so the aim favors the left.</p>
        <ConditionsMathPanel
          evaluation={SAMPLE_EVALUATION}
          windMph={8}
          windRelativeDeg={30}
          hasLiveWind
          elevationDeltaFt={9}
          lieUpDownDeg={1.5}
          lieLeftRightDeg={1.2}
          leavesYds={4}
          altitudeSource="gspro"
        />
        <button type="button" className="live-arm-recommendation" tabIndex={-1}>
          <span className="live-arm-label">HITTING 6i · TAP TO ARM</span>
        </button>
      </article>
    </div>
  )
}

/* ---------- 2. Around the green: the real chip cards and putt card ---------- */

const CHIP_DISTANCE = 18
const GREEN_STARTS = 6

function GreenSample() {
  const options = useMemo(() => chipOptions(
    CHIP_DISTANCE,
    (carry) => ({ surface: carry < GREEN_STARTS ? 'fairway' : 'green', gradeToHole: 0.015 }),
    {
      green: { courseType: 'medium', greenFirmness: 'medium', stimp: 11 },
      fairway: { courseType: 'medium', fairwayFirmness: 'medium' },
      fromRough: false,
      fromSand: false,
      lieUpDownDeg: 0,
    },
    CHIP_DISTANCE - GREEN_STARTS,
  ), [])
  const [shown, setShown] = useState<ChipType | null>(null)
  const [view, setView] = useState<'chip' | 'putt'>('chip')
  return (
    <div className="intro-tour__green">
      <div className="intro-tour__toggle" role="tablist" aria-label="Around the green">
        <button type="button" role="tab" aria-selected={view === 'chip'} onClick={() => setView('chip')}>18 yd chip</button>
        <button type="button" role="tab" aria-selected={view === 'putt'} onClick={() => setView('putt')}>12 ft putt</button>
      </div>
      {view === 'chip' ? (
        <ChipOptionsCard
          distanceYds={CHIP_DISTANCE}
          options={options}
          shown={shown ?? defaultChip(options, CHIP_DISTANCE)?.type ?? null}
          onShow={setShown}
          conditions="Bermuda · medium green, medium fairway · stimp 11"
          hasGreenMap
          surface="fairway"
          lieLeftRightDeg={0}
          lieUpDownDeg={0}
          riseFt={0.8}
          riseSource="green map"
          breakLeftFt={{ bump: 2.6, chip: 2.1, pitch: 1.6, flop: 1.2 }}
        />
      ) : (
        <PuttReadCard distanceFt={12} riseIn={-3} stimp={13} elevationSource="green map" />
      )}
    </div>
  )
}

/* ---------- 3. The range: your bag, learned swing by swing ---------- */

const RANGE_ROWS = [
  { club: 'Driver', carry: 241, miss: '6 yd right', state: 'measured' as const },
  { club: '7i', carry: 156, miss: '3 yd left', state: 'measured' as const },
  { club: '9i', carry: 131, miss: '2 yd right', state: 'learning' as const, shots: 3 },
  { club: 'GW', carry: 108, miss: '—', state: 'starting' as const },
]

function RangeSample() {
  return (
    <div className="intro-tour__panel">
      <div className="intro-tour__panel-head">
        <span className="live-kicker">YOUR BAG</span>
        <span>from your range swings in GSPro</span>
      </div>
      <div className="intro-tour__bag" role="table" aria-label="Sample bag">
        <div className="intro-tour__bag-row is-head" role="row">
          <span role="columnheader">Club</span>
          <span role="columnheader">Carry</span>
          <span role="columnheader">Typical miss</span>
          <span role="columnheader">Status</span>
        </div>
        {RANGE_ROWS.map((row) => (
          <div className="intro-tour__bag-row" role="row" key={row.club}>
            <strong role="cell">{row.club}</strong>
            <span role="cell">{row.carry} yd</span>
            <span role="cell">{row.miss}</span>
            <span role="cell" className={`intro-tour__status is-${row.state}`}>
              {row.state === 'measured' ? 'Measured' : row.state === 'learning' ? `Learning · ${row.shots} of 5` : 'Starting bag'}
            </span>
          </div>
        ))}
      </div>
      <p className="intro-tour__panel-foot">
        No range swings yet? Looper starts from your Driver, 7 iron and pitching wedge and fills in the rest.
      </p>
    </div>
  )
}

/* ---------- 4. Rounds and Your game, putting included ---------- */

const GAME_ROWS = [
  { label: 'Off the tee', sg: -0.4 },
  { label: 'Approach', sg: -1.6 },
  { label: 'Around the green', sg: 0.3 },
  { label: 'Putting', sg: -0.8 },
]
const LEAKS = [
  ['Approach, 150 to 175 yd', '−0.9 a round'],
  ['Putts, 6 to 10 ft', '−0.5 a round'],
  ['Downhill putts, pace', '−0.3 a round'],
]

const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`

function GameSample() {
  return (
    <div className="intro-tour__panel">
      <div className="intro-tour__panel-head">
        <span className="live-kicker">WHERE YOU LOSE STROKES</span>
        <span>strokes gained a round, against the tour</span>
      </div>
      <div className="intro-tour__sg">
        {GAME_ROWS.map((row) => {
          const width = (Math.min(Math.abs(row.sg), 2) / 2) * 100
          return (
            <div className="intro-tour__sg-row" key={row.label}>
              <span>{row.label}</span>
              <span className="intro-tour__sg-bar" aria-hidden="true">
                <span className="is-left">{row.sg < 0 ? <i style={{ width: `${width}%` }} /> : null}</span>
                <span className="is-right">{row.sg > 0 ? <i style={{ width: `${width}%` }} /> : null}</span>
              </span>
              <strong className={row.sg < 0 ? 'is-loss' : 'is-gain'}>{signed(row.sg)}</strong>
            </div>
          )
        })}
      </div>
      <div className="intro-tour__leaks">
        <span className="live-kicker">YOUR BIGGEST LEAKS</span>
        {LEAKS.map(([what, cost]) => (
          <div key={what}><span>{what}</span><strong>{cost}</strong></div>
        ))}
      </div>
    </div>
  )
}

/* ---------- 5. Get set up ---------- */

function SetupSteps({ audience }: { audience: Audience }) {
  const windows = isWindowsBrowser()
  return (
    <ol className="intro-tour__steps">
      <li>
        <strong>{audience === 'visitor' ? 'Make a free account' : 'Set up your bag'}</strong>
        <span>{audience === 'visitor'
          ? 'Then set up your bag. A couple of minutes, from any device, phone included.'
          : 'Next, right here. A couple of minutes, from any device, phone included.'}</span>
      </li>
      <li>
        <strong>Install the Looper Companion on your GSPro PC</strong>
        <span>
          A small Windows app that runs next to GSPro and reads each shot.
          {windows
            ? <> <a href={COMPANION_DOWNLOAD_URL}>Download it</a> if this is your sim.</>
            : ' Open thelooper.golf on that PC and download it there.'}
        </span>
      </li>
      <li>
        <strong>Play</strong>
        <span>Put Looper beside GSPro. It reads every shot and tells you what to hit.</span>
      </li>
    </ol>
  )
}

/* ---------- The tour ---------- */

type Slide = {
  key: string
  kicker: string
  title: ReactNode
  line: ReactNode
  /** Short tags under the line: what sets this card apart. */
  points?: readonly { title: string; text: string }[]
  visual: ReactNode
}

const SWIPE_PX = 50

export default function IntroTour({ audience, onDone, onExit }: Props) {
  const slides: Slide[] = useMemo(() => [
    {
      key: 'caddie',
      kicker: 'The caddie',
      title: <>Your caddie, <em>beside GSPro</em></>,
      line: 'Every shot: the club, the carry and the aim, adjusted for the wind, the lie, the slope and the roll GSPro will give you.',
      points: [
        { title: 'Your game', text: 'Picked from how far you carry each club and how you miss it, not tour averages.' },
        { title: 'Hazard aware', text: 'It sees the bunkers, water and trees, and plays away from the miss that costs you.' },
        { title: 'Course aware', text: 'The real hole, its elevation and the green you’re landing on, not a straight line to the flag.' },
      ],
      visual: <CaddieSample />,
    },
    {
      key: 'green',
      kicker: 'Around the green',
      title: <>Chips and putts, <em>sized for you</em></>,
      line: 'Inside 40 yards, four chips sized to finish at the hole. On the green, how hard to hit the putt for its slope and stimp.',
      visual: <GreenSample />,
    },
    {
      key: 'range',
      kicker: 'The range',
      title: <>The range <em>teaches Looper</em> your bag</>,
      line: 'Hit balls in a range session and Looper learns how far each club carries and how you miss it. The better it knows you, the better it picks.',
      visual: <RangeSample />,
    },
    {
      key: 'game',
      kicker: 'Rounds and Your game',
      title: <>See where your <em>strokes go</em></>,
      line: 'Every round is saved shot by shot. Your game shows where you lose strokes, from the tee to the putts you leave short.',
      visual: <GameSample />,
    },
    {
      key: 'setup',
      kicker: 'Get set up',
      title: audience === 'visitor' ? <>Free, and ready <em>tonight</em></> : <>Two steps <em>and you&rsquo;re playing</em></>,
      line: audience === 'visitor'
        ? 'Make an account now, then install the companion on your sim PC when you get to it.'
        : 'Your bag now, the companion on your GSPro PC when you get to it.',
      visual: <SetupSteps audience={audience} />,
    },
  ], [audience])

  const [index, setIndex] = useState(0)
  const last = slides.length - 1
  const slide = slides[index]
  const touchX = useRef<number | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  const finish = useCallback(() => {
    markIntroTourSeen()
    onDone?.()
  }, [onDone])

  const go = useCallback((next: number) => {
    setIndex(Math.max(0, Math.min(last, next)))
  }, [last])

  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 })
  }, [index])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.key === 'ArrowRight') go(index + 1)
      if (event.key === 'ArrowLeft') go(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, index])

  useEffect(() => {
    if (audience !== 'visitor') return
    const previous = document.title
    document.title = 'How The Looper works'
    return () => {
      document.title = previous
    }
  }, [audience])

  const leave = (to: 'sign-in' | 'sign-up') => (event: MouseEvent) => {
    markIntroTourSeen()
    if (!onExit) return
    event.preventDefault()
    onExit(to)
  }

  const skip = audience === 'visitor'
    ? <a className="intro-tour__skip" href={SIGN_UP_HREF} onClick={leave('sign-up')}>Skip</a>
    : <button type="button" className="intro-tour__skip" onClick={finish}>Skip</button>

  return (
    <div className={`intro-tour is-${audience}`}>
      <header className="intro-tour__top">
        <a className="intro-tour__logo" href={audience === 'visitor' ? '/' : undefined} aria-label="The Looper">
          <img src={looperLogo} alt="The Looper" />
        </a>
        <div className="intro-tour__top-actions">
          {audience === 'visitor' ? <a className="intro-tour__skip" href={SIGN_IN_HREF} onClick={leave('sign-in')}>Sign in</a> : null}
          {index < last ? skip : null}
        </div>
      </header>

      <main
        className="intro-tour__card"
        aria-roledescription="carousel"
        aria-label="How The Looper works"
        onTouchStart={(event) => { touchX.current = event.touches[0]?.clientX ?? null }}
        onTouchEnd={(event) => {
          const start = touchX.current
          touchX.current = null
          const end = event.changedTouches[0]?.clientX
          if (start == null || end == null) return
          if (end - start <= -SWIPE_PX) go(index + 1)
          if (end - start >= SWIPE_PX) go(index - 1)
        }}
      >
        <section className="intro-tour__slide" key={slide.key} aria-roledescription="slide" aria-label={`${index + 1} of ${slides.length}`}>
          <div className="intro-tour__copy">
            <span className="intro-tour__kicker">{index + 1} of {slides.length} · {slide.kicker}</span>
            <h1>{slide.title}</h1>
            <p>{slide.line}</p>
            {slide.points ? (
              <ul className="intro-tour__points">
                {slide.points.map((point) => (
                  <li key={point.title}><strong>{point.title}</strong> {point.text}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="intro-tour__visual" ref={scroller}>
            {slide.visual}
          </div>
        </section>
      </main>

      <footer className={`intro-tour__nav${index === last ? ' is-last' : ''}`}>
        <button type="button" className="intro-tour__back" onClick={() => go(index - 1)} disabled={index === 0}>
          Back
        </button>
        <div className="intro-tour__dots" role="tablist" aria-label="Choose a card">
          {slides.map((s, i) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`${i + 1}: ${s.kicker}`}
              className={i === index ? 'is-current' : ''}
              onClick={() => go(i)}
            />
          ))}
        </div>
        {index < last ? (
          <button type="button" className="intro-tour__next" onClick={() => go(index + 1)}>Next</button>
        ) : audience === 'visitor' ? (
          <a className="intro-tour__next" href={SIGN_UP_HREF} onClick={leave('sign-up')}>Create a free account</a>
        ) : (
          <button type="button" className="intro-tour__next" onClick={finish}>Set up your bag</button>
        )}
      </footer>
      {audience === 'visitor' && index === last ? (
        <p className="intro-tour__signin">Already have an account? <a href={SIGN_IN_HREF} onClick={leave('sign-in')}>Sign in</a></p>
      ) : null}
    </div>
  )
}
