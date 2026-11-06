import { useEffect, useState } from 'react'
import { BAG_CONFIG_UPDATED_EVENT } from './bagConfig'
import type { QuickBagPrior } from './quickBag'
import { QUICK_BAG_UPDATED_EVENT, loadQuickBagPrior } from './quickBagStore'

/** The current Quick Bag prior, refreshed when it or the bag's club list changes. */
export const useQuickBagPrior = (): QuickBagPrior | null => {
  const [prior, setPrior] = useState<QuickBagPrior | null>(() => loadQuickBagPrior())
  useEffect(() => {
    const refresh = () => setPrior(loadQuickBagPrior())
    window.addEventListener(QUICK_BAG_UPDATED_EVENT, refresh)
    window.addEventListener(BAG_CONFIG_UPDATED_EVENT, refresh)
    return () => {
      window.removeEventListener(QUICK_BAG_UPDATED_EVENT, refresh)
      window.removeEventListener(BAG_CONFIG_UPDATED_EVENT, refresh)
    }
  }, [])
  return prior
}
