import { useMemo, useState } from 'react'
import ChipOptionsCard from '../components/ChipOptionsCard'
import { CHIP_ZONE_YDS, chipOptions, defaultChip, familyOf, type ChipType, type LandingSurface } from '../liveCaddie/chipOptions'
import type { Firmness } from '../liveCaddie/roundConditions'

/**
 * /dev/chip-lab: the around-the-green chip cards with sliders, so they can be judged without a round.
 * Past 40 yd the same page shows the partial-wedge flights (23 Nov).
 * The hole is a straight line: `beforeGreen` (fairway or rough) up to where the green starts, then green.
 */
export default function ChipLabPreviewPage() {
  const [distance, setDistance] = useState(18)
  const [greenStarts, setGreenStarts] = useState(4)
  const [beforeGreen, setBeforeGreen] = useState<LandingSurface>('fairway')
  const [slopePct, setSlopePct] = useState(1.5)
  const [stimp, setStimp] = useState(11)
  const [courseType, setCourseType] = useState<Firmness>('medium')
  const [greenFirmness, setGreenFirmness] = useState<Firmness>('medium')
  const [fairwayFirmness, setFairwayFirmness] = useState<Firmness>('medium')
  const [fromRough, setFromRough] = useState(false)
  const [fromSand, setFromSand] = useState(false)
  const [side, setSide] = useState(0)
  const [upDown, setUpDown] = useState(0)
  const [armed, setArmed] = useState<ChipType | null>(null)
  const [playsPct, setPlaysPct] = useState(0)
  const wedge = distance > CHIP_ZONE_YDS

  const options = useMemo(() => chipOptions(
    distance,
    (carry) => ({ surface: carry < greenStarts ? beforeGreen : 'green', gradeToHole: slopePct / 100 }),
    {
      green: { courseType, greenFirmness, stimp },
      fairway: { courseType, fairwayFirmness },
      fromRough: fromRough && (wedge || !fromSand),
      fromSand: fromSand && !wedge,
      lieUpDownDeg: upDown,
    },
    Math.max(0, distance - greenStarts),
    wedge ? 'wedge' : 'chip',
  ), [wedge, distance, greenStarts, beforeGreen, slopePct, stimp, courseType, greenFirmness, fairwayFirmness, fromRough, fromSand, upDown])

  const grass = { soft: 'Bentgrass', medium: 'Bermuda', firm: 'Links' }[courseType]
  const slider = (label: string, value: number, set: (v: number) => void, min: number, max: number, step: number, unit: string) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 13, color: '#9da99f' }}>{label}: <b style={{ color: '#fff' }}>{value}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  )
  const pick = <T extends string>(label: string, value: T, set: (v: T) => void, choices: readonly [T, string][]) => (
    <label style={{ display: 'grid', gap: 4, fontSize: 13, color: '#9da99f' }}>
      {label}
      <select value={value} onChange={(e) => set(e.target.value as T)}>
        {choices.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  )
  const firmness: readonly [Firmness, string][] = [['soft', 'Soft'], ['medium', 'Medium'], ['firm', 'Firm']]
  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '32px 16px', color: '#e7efe4' }}>
      <h2 style={{ marginTop: 0 }}>{wedge ? 'Wedge flights preview' : 'Chip lab preview'}</h2>
      <p style={{ color: '#9da99f' }}>
        Inside 40 yards: the four chips. Past 40: the four wedge flights. Set up a shot and see how far to fly each.
        Flight is from GSPro&rsquo;s own shots; the run is the release model.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, margin: '20px 0 24px' }}>
        {slider('Distance to the pin', distance, setDistance, 4, 100, 1, ' yd')}
        {slider('Green starts', greenStarts, setGreenStarts, 0, 95, 1, ' yd out')}
        {slider('Wind, height and air (wedges)', playsPct, setPlaysPct, -15, 15, 1, '% longer')}
        {slider('Slope to the hole (+ uphill)', slopePct, setSlopePct, -4, 4, 0.5, '%')}
        {slider('Stimp', stimp, setStimp, 8, 13, 0.5, '')}
        {pick('Before the green', beforeGreen, setBeforeGreen, [['fairway', 'Fairway'], ['rough', 'Rough'], ['bunker', 'Bunker'], ['water', 'Water']])}
        {pick('Course type', courseType, setCourseType, [['soft', 'Bentgrass'], ['medium', 'Bermuda'], ['firm', 'Links']])}
        {pick('Green firmness', greenFirmness, setGreenFirmness, firmness)}
        {pick('Fairway firmness', fairwayFirmness, setFairwayFirmness, firmness)}
        {slider('Side slope (+ starts it left)', side, setSide, -8, 8, 0.5, '°')}
        {slider('Up or down slope (+ up)', upDown, setUpDown, -8, 8, 0.5, '°')}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#9da99f' }}>
          <input type="checkbox" checked={fromSand} onChange={(e) => setFromSand(e.target.checked)} /> Hitting from sand
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#9da99f' }}>
          <input type="checkbox" checked={fromRough} onChange={(e) => setFromRough(e.target.checked)} /> Hitting from the rough
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
      <ChipOptionsCard
        distanceYds={distance}
        options={options}
        shown={(armed && familyOf(armed) === (wedge ? 'wedge' : 'chip') ? armed : null) ?? defaultChip(options, distance)?.type ?? null}
        playRatio={1 + playsPct / 100}
        onShow={setArmed}
        conditions={`${grass} · ${greenFirmness} green, ${fairwayFirmness} fairway · stimp ${stimp}`}
        hasGreenMap
        fromSand={fromSand && !wedge}
        lieLeftRightDeg={side}
        lieUpDownDeg={upDown}
        surface={fromSand && !wedge ? 'sand' : fromRough ? 'rough' : 'fairway'}
      />
      </div>
    </main>
  )
}
