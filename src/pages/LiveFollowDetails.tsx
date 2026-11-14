import { useEffect, useState } from 'react'
import { liveFollowLine, refreshGsproFileSummary } from '../lib/gsproFollowDiagnostics'

/**
 * Details: how Live Caddie is following GSPro's round, as one line a player
 * can screenshot. Refreshes itself, because a stuck round sends no updates.
 */
export default function LiveFollowDetails() {
  const [line, setLine] = useState(() => liveFollowLine())
  useEffect(() => {
    let alive = true
    const tick = () => {
      void refreshGsproFileSummary()
        .catch(() => undefined)
        .then(() => { if (alive) setLine(liveFollowLine()) })
    }
    tick()
    const timer = window.setInterval(tick, 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])
  return (
    <div className="live-support-line" data-follow-line>
      <span>Round follow</span>
      <code>{line}</code>
      <button type="button" onClick={() => { void navigator.clipboard?.writeText(line).catch(() => {}) }}>Copy</button>
    </div>
  )
}
