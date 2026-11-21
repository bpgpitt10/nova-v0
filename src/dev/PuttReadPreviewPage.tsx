import { useState } from 'react'
import PuttReadCard from '../components/PuttReadCard'
import { readPutt } from '../liveCaddie/puttRead'

/**
 * /dev/putt-read: the green-side putt card with sliders, so it can be judged without a round in GSPro.
 */
export default function PuttReadPreviewPage() {
  const [distanceFt, setDistanceFt] = useState(24)
  const [riseIn, setRiseIn] = useState(-6)
  const [stimp, setStimp] = useState(12)
  const read = readPutt(distanceFt, riseIn, stimp)
  const slider = (label: string, value: number, set: (v: number) => void, min: number, max: number, step: number, unit: string) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 13, color: '#9da99f' }}>{label}: <b style={{ color: '#fff' }}>{value}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  )
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '32px 16px', color: '#e7efe4' }}>
      <h2 style={{ marginTop: 0 }}>Putt card preview</h2>
      <p style={{ color: '#9da99f' }}>
        What Live Caddie shows on the green. Move the sliders to try a putt; the numbers come from the GSPro putting model.
      </p>
      <div style={{ display: 'grid', gap: 14, margin: '20px 0 24px' }}>
        {slider('Distance', distanceFt, setDistanceFt, 2, 80, 1, ' ft')}
        {slider('Rise (+) or fall (−), ball to hole', riseIn, setRiseIn, -30, 30, 1, ' in')}
        {slider('Stimp', stimp, setStimp, 8, 13, 0.5, '')}
      </div>
      <PuttReadCard distanceFt={distanceFt} riseIn={riseIn} stimp={stimp} />
      <p style={{ color: '#8e9b90', fontSize: 13, marginTop: 16 }}>
        Stroke speed {read.speedMph != null ? `${read.speedMph.toFixed(2)} mph` : '–'} · slope {(read.grade * 100).toFixed(1)}% ·
        steepest downhill that stops at this stimp {read.runawayPercent.toFixed(1)}%
      </p>
    </main>
  )
}
