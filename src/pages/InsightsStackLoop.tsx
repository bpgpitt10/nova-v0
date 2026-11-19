import { useEffect, useMemo, useRef, useState } from 'react'
import {
  STACK_LIES,
  STACK_PIN_YDS,
  STACK_SIDE_SHARE,
  STACK_SIDE_SLOPES_DEG,
  STACK_SWING,
  STACK_TOTALS,
  STACK_TOTAL_SIZES,
} from './insightsStackData'

/**
 * One swing, every outcome: a picture that plays on a loop at the top of the
 * insights page. It starts with a single ball at the pin, then adds one layer
 * at a time (green setting, lie, slope, elevation, altitude) and shows where
 * the same swing finishes in every combination. Nothing to click.
 *
 * Every dot comes from the models that are live in Looper (insightsStackData).
 */

type Step = Readonly<{
  layer: string
  /** What this layer multiplies in, for the list under the picture. */
  options: string
  caption: (spreadYds: number, count: number) => string
}>

const STEPS: readonly Step[] = [
  {
    layer: 'One swing',
    options: `8 iron, ${STACK_SWING.ballSpeedMph} mph, ${STACK_SWING.spinRpm.toLocaleString('en-US')} rpm`,
    caption: () => `One swing. A stock 8 iron that finishes at the pin, ${STACK_PIN_YDS} yards away.`,
  },
  {
    layer: 'Green setting',
    options: '3 grass types × 3 firmness',
    caption: (spread) => `The same swing on GSPro's nine green settings: ${spread} yards from shortest to longest.`,
  },
  {
    layer: 'Lie',
    options: 'fairway, rough, deep rough, sand',
    caption: (spread) => `Now the lie. Rough takes speed and spin, so it comes up short and then runs: ${spread} yards.`,
  },
  {
    layer: 'Slope of the lie',
    options: 'up to 6° up, down or across',
    caption: (spread) => `Now stand on a slope. It changes the launch and the start line: ${spread} yards, and offline.`,
  },
  {
    layer: 'Elevation',
    options: 'up to 30 ft above or below',
    caption: (spread) => `Now the green sits above or below you: ${spread} yards.`,
  },
  {
    layer: 'Altitude',
    options: 'sea level up to 5,000 ft',
    caption: (spread) => `Now the course's altitude: ${spread} yards between the shortest and the longest.`,
  },
]

/** Layers that are real but not measured yet, shown greyed out. */
const COMING = ['Wind', 'Stimp']

const STEP_MS = 4200
const MOVE_MS = 1500
const END_HOLD_MS = 3800
const LIE_COLOURS = ['#76d39b', '#eab308', '#f97316', '#f2e2b8']
const VIEW = { minYds: 92, maxYds: 190, halfWidthYds: 13 }
const GREEN_HALF_DEPTH_YDS = 12

const [GREENS, LIES, UPS, ELEVS, ALTS] = STACK_TOTAL_SIZES
/** The data's grid, as values (the order the generator wrote them in). */
const UP_DEG = [0, -6, -3, 3, 6]
const ELEV_FT = [0, -30, 30]
const ALT_FT = [0, 2500, 5000]
const SIDE_MAX_DEG = Math.max(...STACK_SIDE_SLOPES_DEG)
/**
 * How many ways the swing can finish once each step's layer is in, counting a
 * slope to the nearest degree (13 up or down x 13 across), elevation to the
 * nearest 10 ft (7) and altitude to the nearest 1,000 ft (6).
 */
const SLOPE_WAYS = 13 * 13
const STEP_COUNTS = [1, GREENS, GREENS * LIES, GREENS * LIES * SLOPE_WAYS, GREENS * LIES * SLOPE_WAYS * 7, GREENS * LIES * SLOPE_WAYS * 7 * 6]
/** Dots drawn: each is one of those ways, picked at random (the same ones every time). */
const DOTS = 5200

/** Where `value` falls on an axis of the grid: the two grid slots around it and how far between them. */
const along = (axis: readonly number[], value: number): [number, number, number] => {
  const order = axis.map((at, slot) => [at, slot] as const).sort((a, b) => a[0] - b[0])
  for (let n = 0; n < order.length - 1; n += 1) {
    const [low, lowSlot] = order[n]
    const [high, highSlot] = order[n + 1]
    if (value <= high || n === order.length - 2) return [lowSlot, highSlot, Math.min(1, Math.max(0, (value - low) / (high - low)))]
  }
  return [order[0][1], order[0][1], 0]
}

/** Total distance for any slope, elevation and altitude inside the grid, read between the modelled points. */
const totalAt = (green: number, lie: number, upDeg: number, elevFt: number, altFt: number) => {
  const [u0, u1, ut] = along(UP_DEG, upDeg)
  const [e0, e1, et] = along(ELEV_FT, elevFt)
  const [a0, a1, at] = along(ALT_FT, altFt)
  const grid = STACK_TOTALS[4]
  const read = (u: number, e: number, a: number) => grid[(((green * LIES + lie) * UPS + u) * ELEVS + e) * ALTS + a]
  const mix = (x: number, y: number, t: number) => x + (y - x) * t
  const face = (a: number) => mix(mix(read(u0, e0, a), read(u1, e0, a), ut), mix(read(u0, e1, a), read(u1, e1, a), ut), et)
  return mix(face(a0), face(a1), at)
}

/** The same "random" numbers on every visit, so the picture never changes between loops. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export default function InsightsStackLoop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [step, setStep] = useState(0)

  const model = useMemo(() => {
    const total = DOTS
    const lies = new Uint8Array(total)
    const random = seeded(20261119)
    // Most lies are near level, so slopes and height changes cluster around zero.
    const nearZero = (most: number) => (random() + random() - 1) * most
    // positions[step]: where each dot sits once that step's layer is in.
    const positions = STEPS.map(() => new Float32Array(total * 2))
    for (let i = 0; i < total; i += 1) {
      const green = Math.floor(random() * GREENS)
      const lie = Math.floor(random() * LIES)
      const up = nearZero(6)
      const side = nearZero(SIDE_MAX_DEG)
      const elev = nearZero(30)
      const alt = random() * 5000
      const totals = [
        STACK_PIN_YDS,
        totalAt(green, 0, 0, 0, 0),
        totalAt(green, lie, 0, 0, 0),
        totalAt(green, lie, up, 0, 0),
        totalAt(green, lie, up, elev, 0),
        totalAt(green, lie, up, elev, alt),
      ]
      const turn = Math.sin((side * STACK_SIDE_SHARE[lie] * Math.PI) / 180)
      for (let stepIndex = 0; stepIndex < STEPS.length; stepIndex += 1) {
        positions[stepIndex][i * 2] = totals[stepIndex]
        positions[stepIndex][i * 2 + 1] = stepIndex >= 3 ? totals[stepIndex] * turn : 0
      }
      lies[i] = lie
    }
    // The spread is the modelled extremes, not just the dots that happened to be drawn.
    const spreads = STEPS.map((_, stepIndex) => {
      if (stepIndex === 0) return 0
      const level = STACK_TOTALS[stepIndex - 1]
      return Math.round(Math.max(...level) - Math.min(...level))
    })
    return { total, positions, counts: STEP_COUNTS, spreads, lies }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const context = canvas.getContext('2d')
    if (!context) return undefined
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const lastStep = STEPS.length - 1
    const loopMs = STEP_MS * STEPS.length + END_HOLD_MS
    let frame = 0
    let shownStep = -1
    let visible = true
    const started = performance.now()

    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => { visible = entries.some((entry) => entry.isIntersecting) })
      : null
    observer?.observe(canvas)

    const draw = (now: number) => {
      frame = window.requestAnimationFrame(draw)
      if (!visible && shownStep >= 0) return
      // The first frame's clock can read a hair before the start: never go negative.
      const elapsed = still ? loopMs - 1 : Math.max(0, now - started) % loopMs
      const current = Math.max(0, Math.min(lastStep, Math.floor(elapsed / STEP_MS)))
      const within = elapsed - current * STEP_MS
      const moved = current === 0 ? 1 : Math.min(1, within / MOVE_MS)
      const eased = 1 - (1 - moved) ** 3
      if (current !== shownStep) {
        shownStep = current
        setStep(current)
      }

      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio)
        canvas.height = Math.round(height * ratio)
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)

      const x = (yds: number) => ((yds - VIEW.minYds) / (VIEW.maxYds - VIEW.minYds)) * width
      const mid = height / 2
      const perYard = Math.min(width / (VIEW.maxYds - VIEW.minYds), (height * 0.42) / VIEW.halfWidthYds)
      const y = (sideYds: number) => mid + sideYds * perYard

      // The hole from above: rough, a band of fairway, the green and the pin.
      context.fillStyle = '#0c1a11'
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#12281a'
      context.fillRect(0, mid - 9 * perYard, width, 18 * perYard)
      context.fillStyle = '#1c3d28'
      context.beginPath()
      context.ellipse(x(STACK_PIN_YDS), mid, x(STACK_PIN_YDS + GREEN_HALF_DEPTH_YDS) - x(STACK_PIN_YDS), 10.5 * perYard, 0, 0, Math.PI * 2)
      context.fill()
      context.strokeStyle = 'rgba(242, 226, 184, 0.28)'
      context.lineWidth = 1
      context.stroke()

      // Distance marks every 10 yards.
      context.font = '600 11px Inter, system-ui, sans-serif'
      context.textAlign = 'center'
      for (let yds = 100; yds <= 180; yds += 10) {
        context.fillStyle = 'rgba(255, 255, 255, 0.07)'
        context.fillRect(x(yds), 0, 1, height)
        context.fillStyle = 'rgba(207, 216, 205, 0.6)'
        context.fillText(`${yds}`, x(yds), height - 8)
      }

      // The dots. Before the lie is added they are all one colour.
      const from = model.positions[Math.max(0, current - 1)]
      const to = model.positions[current]
      const count = model.counts[current]
      const radius = count <= 9 ? 5 : count <= 36 ? 4 : 1.6
      context.globalAlpha = count <= 36 ? 0.95 : 0.42
      // Deep rough first and fairway last, so the shots that reach the green stay visible.
      for (const lie of [2, 3, 1, 0]) {
        context.fillStyle = current >= 2 ? LIE_COLOURS[lie] : '#eab308'
        context.beginPath()
        for (let i = 0; i < model.total; i += 1) {
          if (model.lies[i] !== lie) continue
          const px = x(from[i * 2] + (to[i * 2] - from[i * 2]) * eased)
          const py = y(from[i * 2 + 1] + (to[i * 2 + 1] - from[i * 2 + 1]) * eased)
          if (radius < 2) {
            context.rect(px - radius, py - radius, radius * 2, radius * 2)  // thousands of dots: squares draw far faster
          } else {
            context.moveTo(px + radius, py)
            context.arc(px, py, radius, 0, Math.PI * 2)
          }
        }
        context.fill()
      }
      context.globalAlpha = 1

      // The pin, on top.
      const pinX = x(STACK_PIN_YDS)
      context.fillStyle = '#ffffff'
      context.fillRect(pinX - 1, mid - 26, 2, 26)
      context.fillStyle = '#eab308'
      context.beginPath()
      context.moveTo(pinX + 1, mid - 26)
      context.lineTo(pinX + 15, mid - 21)
      context.lineTo(pinX + 1, mid - 16)
      context.fill()
      context.fillStyle = '#ffffff'
      context.beginPath()
      context.arc(pinX, mid, 2.5, 0, Math.PI * 2)
      context.fill()
    }
    frame = window.requestAnimationFrame(draw)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [model])

  const count = model.counts[step]
  const spread = model.spreads[step]

  return (
    <section className="insights-stack" aria-label="One swing, every outcome">
      <div className="insights-wrap">
        <div className="insights-stack__head">
          <div>
            <p className="insights-eyebrow">One swing, every outcome</p>
            <p className="insights-stack__caption" aria-live="off">{STEPS[step].caption(spread, count)}</p>
          </div>
          <dl className="insights-stack__numbers">
            <div>
              <dt>Ways it can finish</dt>
              <dd>{count.toLocaleString('en-US')}</dd>
            </div>
            <div>
              <dt>Shortest to longest</dt>
              <dd>{spread} yd</dd>
            </div>
          </dl>
        </div>
        <canvas
          className="insights-stack__canvas"
          ref={canvasRef}
          role="img"
          aria-label={`A hole seen from above with a pin at ${STACK_PIN_YDS} yards. Dots show where one identical swing finishes as green setting, lie, slope, elevation and altitude are added: ${model.counts[STEPS.length - 1].toLocaleString('en-US')} outcomes spread over ${model.spreads[STEPS.length - 1]} yards.`}
        />
        <ol className="insights-stack__layers">
          {STEPS.map((item, index) => (
            <li className={index < step ? 'is-done' : index === step ? 'is-on' : ''} key={item.layer}>
              <strong>{item.layer}</strong>
              <span>{item.options}</span>
            </li>
          ))}
          {COMING.map((name) => (
            <li className="is-coming" key={name}>
              <strong>{name}</strong>
              <span>still being measured</span>
            </li>
          ))}
        </ol>
        <div className="insights-stack__key" aria-hidden={step < 2}>
          {STACK_LIES.map((lie, index) => (
            <span key={lie} style={{ opacity: step >= 2 ? 1 : 0.35 }}>
              <i style={{ background: LIE_COLOURS[index] }} />
              {lie}
            </span>
          ))}
          <span className="insights-stack__note">
            Every dot is the same swing. Slopes counted to the nearest degree, elevation to 10 ft, altitude to 1,000 ft.
          </span>
        </div>
      </div>
    </section>
  )
}
