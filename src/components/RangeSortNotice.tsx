import { useEffect, useState } from 'react'
import { loadUnsortedRangeVisits } from '../lib/rangeSortData'
import './RangeSortNotice.css'

/** Home page: range swings Looper saw with no club tagged, with a way to sort them into the bag. */
const MIN_SWINGS = 5

export default function RangeSortNotice() {
  const [swings, setSwings] = useState(0)
  useEffect(() => {
    let alive = true
    loadUnsortedRangeVisits()
      .then((visits) => { if (alive) setSwings(visits.reduce((sum, visit) => sum + visit.swings.length, 0)) })
      .catch(() => { /* the notice is optional */ })
    return () => { alive = false }
  }, [])
  if (swings < MIN_SWINGS) return null
  return (
    <a className="range-sort-notice" href="/range-sort">
      <span><strong>{swings} range swings</strong> aren’t in your bag yet: no club was tagged.</span>
      <span className="range-sort-notice__go">Sort them <span aria-hidden="true">→</span></span>
    </a>
  )
}
