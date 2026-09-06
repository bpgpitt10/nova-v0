import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LooperLandingPage from './pages/LooperLandingPage.tsx'
import SessionSummaryPage from './pages/SessionSummaryPage.tsx'
import SessionIntelligencePage from './pages/SessionIntelligencePage.tsx'
import DataManagementPage from './pages/DataManagementPage.tsx'
import BagSetupPage from './pages/BagSetupPage.tsx'
import ShotVariantsPage from './pages/ShotVariantsPage.tsx'
import TheReadPage from './pages/TheReadPage.tsx'
import BrowserGsproSpikePage from './pages/BrowserGsproSpikePage.tsx'
import BrowserGsproSetupGate from './components/BrowserGsproSetupGate.tsx'
import {
  BAG_CONFIG_UPDATED_EVENT,
  hasSavedBagConfig,
  refreshBagConfigState,
} from './lib/bagConfig.ts'
import { checkForLooperUpdate } from './lib/updater.ts'
import type { Update } from '@tauri-apps/plugin-updater'

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'unavailable'
  | 'up-to-date'
  | 'available'
  | 'installing'
  | 'installed'
  | 'error'

const normalizePath = (value: string) => value.replace(/\/+$/, '') || '/'

function RootRouter() {
  const [pathname, setPathname] = useState(() => normalizePath(window.location.pathname))
  const [hasBagConfig, setHasBagConfig] = useState(() => hasSavedBagConfig())
  const [bagConfigRevision, setBagConfigRevision] = useState(0)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)

  const checkForUpdates = useCallback(async () => {
    setUpdateStatus('checking')
    setUpdateError(null)

    try {
      const result = await checkForLooperUpdate()
      if (result.status === 'available') {
        setAvailableUpdate(result.update)
        setUpdateStatus('available')
        return
      }
      setAvailableUpdate(null)
      setUpdateStatus(result.status)
    } catch (error) {
      console.error('Failed to check for updates.', error)
      setAvailableUpdate(null)
      setUpdateError(error instanceof Error ? error.message : 'Update check failed.')
      setUpdateStatus('error')
    }
  }, [])

  const installAvailableUpdate = useCallback(async () => {
    if (!availableUpdate) {
      return
    }

    setUpdateStatus('installing')
    setUpdateError(null)

    try {
      await availableUpdate.downloadAndInstall()
      setUpdateStatus('installed')
    } catch (error) {
      console.error('Failed to install update.', error)
      setUpdateError(error instanceof Error ? error.message : 'Update install failed.')
      setUpdateStatus('error')
    }
  }, [availableUpdate])

  useEffect(() => {
    void checkForUpdates()
  }, [checkForUpdates])

  useEffect(() => {
    const onPopState = () => {
      setPathname(normalizePath(window.location.pathname))
    }

    const onDocumentClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) {
        return
      }
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return
      }

      const target = event.target
      if (!(target instanceof Element)) {
        return
      }

      const anchor = target.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) {
        return
      }
      if (anchor.target && anchor.target !== '_self') {
        return
      }
      if (anchor.hasAttribute('download')) {
        return
      }

      const rawHref = anchor.getAttribute('href')
      if (!rawHref || !rawHref.startsWith('/')) {
        return
      }

      const url = new URL(rawHref, window.location.origin)
      const next = `${url.pathname}${url.search}${url.hash}`
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`

      if (next === current) {
        return
      }

      event.preventDefault()
      window.history.pushState({}, '', next)
      setPathname(normalizePath(url.pathname))
    }

    window.addEventListener('popstate', onPopState)
    document.addEventListener('click', onDocumentClick)
    const onBagConfigUpdated = () => {
      refreshBagConfigState()
      setHasBagConfig(hasSavedBagConfig())
      setBagConfigRevision((current) => current + 1)
    }
    window.addEventListener(BAG_CONFIG_UPDATED_EVENT, onBagConfigUpdated)
    window.addEventListener('storage', onBagConfigUpdated)

    return () => {
      window.removeEventListener('popstate', onPopState)
      document.removeEventListener('click', onDocumentClick)
      window.removeEventListener(BAG_CONFIG_UPDATED_EVENT, onBagConfigUpdated)
      window.removeEventListener('storage', onBagConfigUpdated)
    }
  }, [])

  useEffect(() => {
    if (
      hasBagConfig ||
      pathname === '/bag-setup' ||
      pathname === '/browser-gspro-spike'
    ) {
      return
    }
    window.history.replaceState({}, '', '/bag-setup')
    setPathname('/bag-setup')
  }, [bagConfigRevision, hasBagConfig, pathname])

  const view = useMemo(() => {
    const showBrowserGsproSpike = pathname === '/browser-gspro-spike'
    const showBagSetup = pathname === '/bag-setup'
    const showShotVariants = pathname === '/edit-bag/variants'
    const showLooperLanding = pathname === '/' || pathname === '/looper'
    const showSessionSummary = pathname === '/session-summary' || pathname === '/sessionsummary'
    const showSessionIntelligence = pathname === '/session-intelligence'
    const showDashboardRoute = pathname === '/dashboard'
    const showTheRead = pathname === '/read'
    const showDataManagement = pathname === '/data-management' || pathname === '/manage-data'

    if (showBrowserGsproSpike) {
      return <BrowserGsproSpikePage />
    }
    if (showBagSetup || !hasBagConfig) {
      return <BagSetupPage />
    }
    if (showShotVariants) {
      return <ShotVariantsPage />
    }
    if (showSessionSummary) {
      return <SessionSummaryPage />
    }
    if (showDataManagement) {
      return <DataManagementPage />
    }
    if (showSessionIntelligence) {
      return <SessionIntelligencePage />
    }
    if (showTheRead) {
      return <TheReadPage />
    }
    if (showLooperLanding) {
      return (
        <LooperLandingPage
          installAvailableUpdate={installAvailableUpdate}
          updateError={updateError}
          updateStatus={updateStatus}
          onRetryUpdateCheck={checkForUpdates}
        />
      )
    }
    return <App forceDashboardRoute={showDashboardRoute} />
  }, [checkForUpdates, hasBagConfig, installAvailableUpdate, pathname, updateError, updateStatus])

  return (
    <BrowserGsproSetupGate bypass={pathname === '/browser-gspro-spike'}>
      {view}
    </BrowserGsproSetupGate>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootRouter />
  </StrictMode>,
)
