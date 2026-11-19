import { useEffect, useMemo, useRef, useState } from 'react'
import {
  STACK_ALT_FT,
  STACK_ELEV_FT,
  STACK_GRID,
  STACK_LIES,
  STACK_PIN_YDS,
  STACK_SIDE_SHARE,
  STACK_SPREADS,
  STACK_TOTAL_SIZES,
  STACK_UP_DEG,
  STACK_WIND_10MPH,
} from './insightsStackData'
import {
  INSIGHT_BASELINE,
  INSIGHT_HOLE,
  describeLeave,
  finishOf,
  type InsightConditions,
} from './insightsShotModel'

/**
 * One shot, six things to adjust for: a picture that plays on a loop at the
 * top of the insights page. Nothing to click.
 *
 * It follows one shot the way a player would have to work it out: a stock
 * 8 iron that goes 150, then the green, the lie, the slope, the elevation, the
 * altitude and the wind, with the running number after each. Behind it, a
 * cloud of dots shows where the same swing finishes across the whole range of
 * each condition.
 *
 * The followed shot is worked out by the live models as the page loads. The
 * cloud is read from a grid of those same models (insightsStackData).
 */

type Step = Readonly<{
  layer: string
  /** The followed shot's condition at this step. */
  example: string
  /** What the player would have to know. */
  know: string
  change: Partial<InsightConditions>
}>

const STEPS: readonly Step[] = [
  { layer: 'One swing', example: 'Stock 8 iron', know: 'Your stock 8 iron: level fairway lie, Bermuda medium green, still air.', change: {} },
  { layer: 'Green', example: 'Links, firm', know: 'The green is Links and firm. It releases further.', change: { grass: 'firm', firmness: 'firm' } },
  { layer: 'Lie', example: 'Rough', know: 'The ball is in the rough. Less carry, less spin, more run.', change: { lie: 'rough' } },
  { layer: 'Slope', example: '3° downhill, ball below feet', know: 'A downhill lie with the ball below your feet. Lower launch, and it starts right.', change: { slopeUpDeg: -3, slopeRightDeg: 2 } },
  { layer: 'Elevation', example: 'Green 20 ft below', know: 'The green is 20 feet below you. It stays in the air longer.', change: { elevationFt: -20 } },
  { layer: 'Altitude', example: '2,500 ft', know: 'The course is at 2,500 feet. Thinner air, more carry.', change: { altitudeFt: 2500 } },
  { layer: 'Wind', example: '10 mph, into from the left', know: 'A 10 mph wind, into you and from the left. Shorter, and further right.', change: { windMph: 10, windFromDeg: 300 } },
]

const STEP_MS = 4200
const MOVE_MS = 1500
const SUMMARY_MS = 5200
const LIE_COLOURS = ['#76d39b', '#eab308', '#f97316', '#f2e2b8']
const VIEW = { minYds: 86, maxYds: 192, halfWidthYds: 19 }
const DOTS = 5200
const WIND_MAX_MPH = 15
const [GREENS, LIES, UPS, ELEVS, ALTS] = STACK_TOTAL_SIZES

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
const mix = (x: number, y: number, t: number) => x + (y - x) * t

/** Total distance in still air for any slope, elevation and altitude inside the grid, read between the modelled points. */
const totalAt = (green: number, lie: number, upDeg: number, elevFt: number, altFt: number) => {
  const [u0, u1, ut] = along(STACK_UP_DEG, upDeg)
  const [e0, e1, et] = along(STACK_ELEV_FT, elevFt)
  const [a0, a1, at] = along(STACK_ALT_FT, altFt)
  const read = (u: number, e: number, a: number) => STACK_GRID[(((green * LIES + lie) * UPS + u) * ELEVS + e) * ALTS + a]
  const face = (a: number) => mix(mix(read(u0, e0, a), read(u1, e0, a), ut), mix(read(u0, e1, a), read(u1, e1, a), ut), et)
  return mix(face(a0), face(a1), at)
}

/** What a wind does to distance and to line, from the 10 mph figures for this lie and slope. */
const windAt = (lie: number, upDeg: number, mph: number, fromDeg: number): [number, number] => {
  const [u0, u1, ut] = along(STACK_UP_DEG, upDeg)
  const low = STACK_WIND_10MPH[lie * UPS + u0]
  const high = STACK_WIND_10MPH[lie * UPS + u1]
  const into = (mph / 10) * Math.cos((fromDeg * Math.PI) / 180)
  const fromLeft = -(mph / 10) * Math.sin((fromDeg * Math.PI) / 180)
  const distance = into >= 0 ? mix(low[0], high[0], ut) * into : mix(low[1], high[1], ut) * -into
  return [distance, mix(low[2], high[2], ut) * fromLeft]
}

/** The same "random" numbers on every visit, so the picture never changes between loops. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const yards = (value: number) => `${Math.round(value)}`
const signed = (value: number) => (Math.round(value) === 0 ? '±0' : `${value > 0 ? '+' : '−'}${Math.abs(Math.round(value))}`)
const sideText = (value: number) => (Math.abs(value) < 0.75 ? 'on line' : `${Math.round(Math.abs(value))} yd ${value > 0 ? 'right' : 'left'}`)

export default function InsightsStackLoop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // 0 to 6 are the layers; 7 is the closing summary.
  const [step, setStep] = useState(0)

  /** The followed shot after each layer, from the live models. */
  const followed = useMemo(() => {
    let conditions = INSIGHT_BASELINE
    return STEPS.map((item) => {
      conditions = { ...conditions, ...item.change }
      return finishOf(conditions, STACK_PIN_YDS)
    })
  }, [])
  const final = followed[followed.length - 1]
  const leave = useMemo(() => describeLeave(final.totalYds - STACK_PIN_YDS, final.sideYds), [final])

  const cloud = useMemo(() => {
    const lies = new Uint8Array(DOTS)
    const random = seeded(20261119)
    // Most lies are near level, so slopes and height changes cluster around zero.
    const nearZero = (most: number) => (random() + random() - 1) * most
    const positions = STEPS.map(() => new Float32Array(DOTS * 2))
    for (let i = 0; i < DOTS; i += 1) {
      const green = Math.floor(random() * GREENS)
      const lie = Math.floor(random() * LIES)
      const up = nearZero(6)
      const side = nearZero(6)
      const elev = nearZero(30)
      const alt = random() * 5000
      const [windYds, windSide] = windAt(lie, up, (random() + random()) * 0.5 * WIND_MAX_MPH, random() * 360)
      const totals = [
        STACK_PIN_YDS,
        totalAt(green, 0, 0, 0, 0),
        totalAt(green, lie, 0, 0, 0),
        totalAt(green, lie, up, 0, 0),
        totalAt(green, lie, up, elev, 0),
        totalAt(green, lie, up, elev, alt),
        totalAt(green, lie, up, elev, alt) + windYds,
      ]
      const turn = Math.sin((side * STACK_SIDE_SHARE[lie] * Math.PI) / 180)
      for (let at = 0; at < STEPS.length; at += 1) {
        positions[at][i * 2] = totals[at]
        positions[at][i * 2 + 1] = (at >= 3 ? totals[at] * turn : 0) + (at >= 6 ? windSide : 0)
      }
      lies[i] = lie
    }
    return { lies, positions }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const context = canvas.getContext('2d')
    if (!context) return undefined
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const lastStep = STEPS.length - 1
    const loopMs = STEP_MS * STEPS.length + SUMMARY_MS
    let frame = 0
    let shown = -1
    let visible = true
    const started = performance.now()
    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => { visible = entries.some((entry) => entry.isIntersecting) })
      : null
    observer?.observe(canvas)

    const draw = (now: number) => {
      frame = window.requestAnimationFrame(draw)
      if (!visible && shown >= 0) return
      // The first frame's clock can read a hair before the start: never go negative.
      const elapsed = still ? loopMs - 1 : Math.max(0, now - started) % loopMs
      const phase = Math.floor(elapsed / STEP_MS)
      const current = Math.max(0, Math.min(lastStep, phase))
      const moved = current === 0 || phase > lastStep ? 1 : Math.min(1, (elapsed - current * STEP_MS) / MOVE_MS)
      const eased = 1 - (1 - moved) ** 3
      const showing = phase > lastStep ? STEPS.length : current
      if (showing !== shown) {
        shown = showing
        setStep(showing)
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
      const mid = (height - 18) / 2
      const perYard = Math.min(width / (VIEW.maxYds - VIEW.minYds), ((height - 18) * 0.47) / VIEW.halfWidthYds)
      const y = (sideYds: number) => mid + sideYds * perYard

      // The hole from above: rough, a band of fairway, the green and the pin.
      context.fillStyle = '#0c1a11'
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#12281a'
      context.fillRect(0, mid - 14 * perYard, width, 28 * perYard)
      const yardsWide = (yds: number) => x(STACK_PIN_YDS + yds) - x(STACK_PIN_YDS)
      const { green, bunkers } = INSIGHT_HOLE
      context.fillStyle = '#1c3d28'
      context.beginPath()
      context.ellipse(x(STACK_PIN_YDS + green.longYds), y(green.rightYds), yardsWide(green.halfDepthYds), green.halfWidthYds * perYard, 0, 0, Math.PI * 2)
      context.fill()
      context.strokeStyle = 'rgba(242, 226, 184, 0.28)'
      context.lineWidth = 1
      context.stroke()
      context.fillStyle = 'rgba(214, 196, 150, 0.34)'
      for (const bunker of bunkers) {
        context.beginPath()
        context.ellipse(x(STACK_PIN_YDS + bunker.longYds), y(bunker.rightYds), yardsWide(bunker.halfDepthYds), bunker.halfWidthYds * perYard, 0, 0, Math.PI * 2)
        context.fill()
      }

      context.font = '600 11px Inter, system-ui, sans-serif'
      context.textAlign = 'center'
      for (let yds = 90; yds <= 190; yds += 10) {
        context.fillStyle = 'rgba(255, 255, 255, 0.07)'
        context.fillRect(x(yds), 0, 1, height)
        context.fillStyle = 'rgba(207, 216, 205, 0.6)'
        context.fillText(`${yds}`, x(yds), height - 6)
      }

      // The cloud: the same swing across the whole range of every layer added so far.
      const from = cloud.positions[Math.max(0, current - 1)]
      const to = cloud.positions[current]
      const few = current <= 2
      const radius = current === 0 ? 5 : few ? 4 : 1.6
      context.globalAlpha = few ? 0.5 : 0.36
      // Deep rough first and fairway last, so the shots that reach the green stay visible.
      for (const lie of [2, 3, 1, 0]) {
        context.fillStyle = current >= 2 ? LIE_COLOURS[lie] : '#eab308'
        context.beginPath()
        for (let i = 0; i < DOTS; i += 1) {
          if (cloud.lies[i] !== lie) continue
          const px = x(from[i * 2] + (to[i * 2] - from[i * 2]) * eased)
          const py = y(from[i * 2 + 1] + (to[i * 2 + 1] - from[i * 2 + 1]) * eased)
          if (few) {
            context.moveTo(px + radius, py)
            context.arc(px, py, radius, 0, Math.PI * 2)
          } else {
            context.rect(px - radius, py - radius, radius * 2, radius * 2) // thousands of dots: squares draw far faster
          }
        }
        context.fill()
      }
      context.globalAlpha = 1

      // The pin.
      const pinX = x(STACK_PIN_YDS)
      context.fillStyle = '#ffffff'
      context.fillRect(pinX - 1, mid - 26, 2, 26)
      context.fillStyle = '#eab308'
      context.beginPath()
      context.moveTo(pinX + 1, mid - 26)
      context.lineTo(pinX + 15, mid - 21)
      context.lineTo(pinX + 1, mid - 16)
      context.fill()

      // The followed shot: where it has been, and where it is now.
      const before = followed[Math.max(0, current - 1)]
      const after = followed[current]
      const ballX = x(before.totalYds + (after.totalYds - before.totalYds) * eased)
      const ballY = y(before.sideYds + (after.sideYds - before.sideYds) * eased)
      context.strokeStyle = 'rgba(255, 255, 255, 0.55)'
      context.lineWidth = 1.5
      context.setLineDash([4, 4])
      context.beginPath()
      context.moveTo(x(followed[0].totalYds), y(followed[0].sideYds))
      for (let n = 1; n < current; n += 1) context.lineTo(x(followed[n].totalYds), y(followed[n].sideYds))
      context.lineTo(ballX, ballY)
      context.stroke()
      context.setLineDash([])
      context.fillStyle = '#ffffff'
      context.strokeStyle = '#07100a'
      context.lineWidth = 2.5
      context.beginPath()
      context.arc(ballX, ballY, 7, 0, Math.PI * 2)
      context.fill()
      context.stroke()
    }
    frame = window.requestAnimationFrame(draw)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [cloud, followed])

  const summary = step >= STEPS.length
  const at = Math.min(step, STEPS.length - 1)
  const now = followed[at]
  const off = final.totalYds - STACK_PIN_YDS
  const caption = summary
    ? `Six adjustments. Hit it like a normal ${STACK_PIN_YDS} and you finish ${Math.abs(Math.round(off)) < 1 ? 'pin high' : `${Math.abs(Math.round(off))} yards ${off > 0 ? 'long' : 'short'}`} and ${sideText(final.sideYds).replace(' yd', ' yards')}. ${leave.headline}`
    : STEPS[at].know

  return (
    <section className="insights-stack" aria-label="One shot, six things to adjust for">
      <div className="insights-wrap">
        <div className="insights-stack__head">
          <div>
            <p className="insights-eyebrow">One shot, six things to adjust for</p>
            <p className="insights-stack__caption">{caption}</p>
          </div>
          <dl className="insights-stack__numbers">
            <div>
              <dt>Adjustments so far</dt>
              <dd>{at}<small> of {STEPS.length - 1}</small></dd>
            </div>
            <div>
              <dt>Your 150 swing now goes</dt>
              <dd>{yards(now.totalYds)}<small> yd{at >= 3 ? `, ${sideText(now.sideYds)}` : ''}</small></dd>
            </div>
          </dl>
        </div>
        <canvas
          className="insights-stack__canvas"
          ref={canvasRef}
          role="img"
          aria-label={`A hole seen from above with a pin at ${STACK_PIN_YDS} yards. One stock 8 iron is followed as six conditions are added and ends up ${yards(final.totalYds)} yards out, ${sideText(final.sideYds)}. Behind it, dots show where the same swing can finish: ${STACK_SPREADS[STACK_SPREADS.length - 1]} yards from shortest to longest.`}
        />
        <ol className="insights-stack__layers">
          {STEPS.map((item, index) => (
            <li className={index < at || summary ? 'is-done' : index === at ? 'is-on' : ''} key={item.layer}>
              <strong>{item.layer}</strong>
              <span>{item.example}</span>
              <b>{index === 0 ? `${STACK_PIN_YDS} yd` : index <= at ? `${signed(followed[index].totalYds - followed[index - 1].totalYds)} yd` : ''}</b>
            </li>
          ))}
          <li className="is-coming">
            <strong>Stimp</strong>
            <span>still being measured</span>
            <b />
          </li>
        </ol>
        <div className="insights-stack__key">
          <span><i className="insights-stack__ball" />This shot</span>
          {STACK_LIES.map((lie, index) => (
            <span key={lie} style={{ opacity: at >= 2 ? 1 : 0.35 }}>
              <i style={{ background: LIE_COLOURS[index] }} />
              {lie}
            </span>
          ))}
          <span className="insights-stack__note">
            {at === 0
              ? 'The dots: the same swing in every other condition.'
              : `The dots: the same swing in every other condition, ${STACK_SPREADS[at]} yards from shortest to longest.`}
          </span>
        </div>
      </div>
    </section>
  )
}
