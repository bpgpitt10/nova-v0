import { useMemo } from 'react'
import RangeSortPage from '../pages/RangeSortPage'
import type { Club } from '../lib/bagConfig'
import { groupVisits, type RangeSwing } from '../lib/rangeSort'

/** /dev/range-sort: the range sorter with a made-up visit, so it can be judged without range swings. */
const BLOCKS: readonly [Club | null, number, number, readonly number[], number][] = [
  // club guess, ball speed, launch, carries, pause before (s)
  ['PW', 98, 25, [129, 122, 127, 126], 0],
  ['SW', 88, 27, [105, 104, 112, 111], 96],
  ['9i', 104, 23, [139, 137, 130, 138, 140, 96], 120],
  ['8i', 109, 21, [150, 155, 152, 161, 150], 90],
  ['7i', 118, 18, [167, 171, 165, 172, 173, 164, 138, 170], 138],
  [null, 70, 17, [73], 80],
  ['5i', 126, 14, [191, 187, 194, 194, 192, 195], 96],
  ['Driver', 152, 11.5, [251, 240, 263, 245, 241, 251, 253], 135],
]

const sampleSwings = (): RangeSwing[] => {
  const swings: RangeSwing[] = []
  let at = Date.parse('2026-11-21T19:30:00')
  BLOCKS.forEach(([guess, mph, launch, carries, pause]) => {
    at += pause * 1000
    const middle = [...carries].sort((a, b) => a - b)[Math.floor(carries.length / 2)]
    carries.forEach((carry, i) => {
      at += 30_000
      const share = carry / middle
      swings.push({
        id: `sample-${swings.length}`, seq: swings.length, at,
        ballSpeedMph: mph * (0.55 + 0.45 * share) + (i % 3) - 1,
        launchDeg: launch + ((i % 4) - 1.5) * 0.6,
        startDirectionDeg: ((i * 7) % 5) - 2,
        spinRpm: 2600 + (170 - mph) * 55, spinAxisDeg: ((i * 3) % 7) - 3,
        backSpinRpm: null, sideSpinRpm: null,
        carryYds: carry, totalYds: carry + 9, offlineYds: ((i * 5) % 13) - 6,
        guess, guessConfidence: guess ? 0.5 : null,
      })
    })
  })
  return swings
}

export default function RangeSortPreviewPage() {
  const visits = useMemo(() => groupVisits(sampleSwings()), [])
  return <RangeSortPage sampleVisits={visits} />
}
