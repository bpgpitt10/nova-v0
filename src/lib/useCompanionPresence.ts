import { useEffect, useState } from 'react'
import { fetchLatestCompanionRelease, type CompanionLatest } from './companionRelease'
import { checkCompanionPresence, POLL_MS, type CompanionPresence } from './companionPresence'

const INITIAL: CompanionPresence = {
  status: 'checking', release: null, gspro: null, latest: null, update: 'unknown', seen: null, checkedAt: null,
}

/** Polls the companion every 15 s (and on focus); shared by the chip and the pages. */
export const useCompanionPresence = (): CompanionPresence => {
  const [presence, setPresence] = useState<CompanionPresence>(INITIAL)
  useEffect(() => {
    let cancelled = false
    let latest: CompanionLatest | null = null
    const look = async () => {
      const next = await checkCompanionPresence(latest)
      if (!cancelled) setPresence(next)
    }
    void fetchLatestCompanionRelease().then((value) => {
      latest = value
      return look()
    })
    const timer = window.setInterval(() => void look(), POLL_MS)
    const onFocus = () => void look()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])
  return presence
}
