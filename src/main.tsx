import { StrictMode, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LooperLandingPage from './pages/LooperLandingPage.tsx'
import SessionSummaryPage from './pages/SessionSummaryPage.tsx'
import SessionIntelligencePage from './pages/SessionIntelligencePage.tsx'
import LiveCaddiePage from './pages/LiveCaddiePage.tsx'
import RoundSetupPage from './pages/RoundSetupPage.tsx'
import LoadCoursePage from './pages/LoadCoursePage.tsx'
import DataManagementPage from './pages/DataManagementPage.tsx'
import BagSetupPage from './pages/BagSetupPage.tsx'
import ShotVariantsPage from './pages/ShotVariantsPage.tsx'
import TheReadPage from './pages/TheReadPage.tsx'
import RoundsPage from './pages/RoundsPage.tsx'
import AdminUsersPage from './pages/AdminUsersPage.tsx'
import CloudRepairPage from './pages/CloudRepairPage.tsx'
import CourseRenderDevPage from './dev/CourseRenderDevPage.tsx'
import CourseGeometryDevPage from './dev/CourseGeometryDevPage.tsx'
import GsproMarkerAlignmentLab from './dev/GsproMarkerAlignmentLab.tsx'
import AimLabPage from './dev/AimLabPage.tsx'
import CaddieInputsPage from './dev/CaddieInputsPage.tsx'
import GsproReplayDevPage from './dev/GsproReplayDevPage.tsx'
import DecisionReplayDevPage from './dev/DecisionReplayDevPage.tsx'
import DecisionAuditDevPage from './dev/DecisionAuditDevPage.tsx'
import OcrTestPage from './dev/OcrTestPage.tsx'
import BrowserGsproSetupGate from './components/BrowserGsproSetupGate.tsx'
import LooperAuthGate from './components/LooperAuthGate.tsx'
import { signOutLooper } from './cloud/supabaseClient.ts'
import {
  BAG_CONFIG_UPDATED_EVENT,
  hasSavedBagConfig,
  refreshBagConfigState,
} from './lib/bagConfig.ts'
import { deactivateLocalUserScope } from './lib/localUserScope.ts'
import { clearActiveSessionDraft, loadActiveSessionDraft } from './lib/sessions.ts'
import { startLiveGsproCourseRoundArchiver } from './lib/liveGsproRoundArchive.ts'
import { startLiveCaddieShotLineage } from './liveCaddie/shotLineageStore.ts'
import { startLiveCaddieRoundTeeValidator } from './liveCaddie/roundTeeValidator.ts'
import {
  loadActiveLiveCaddieRound,
  startLiveCaddieRound,
} from './liveCaddie/roundRuntime.ts'
import { checkForLooperUpdate, type LooperUpdate as Update } from './lib/updater.ts'

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
const isLiveCaddiePath = (value: string) => {
  const normalized = normalizePath(value)
  return normalized === '/live-caddie' || normalized === '/caddie' || normalized === '/dev/live-caddie'
}

function SignOutPage() {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void signOutLooper()
      .then(() => {
        deactivateLocalUserScope()
        window.location.replace('/')
      })
      .catch((signOutError) => {
        setError(signOutError instanceof Error ? signOutError.message : String(signOutError))
      })
  }, [])

  return (
    <main style={{ padding: '2rem' }}>
      <p>{error ? `Could not sign out: ${error}` : 'Signing you out…'}</p>
    </main>
  )
}

function InterruptedSessionGate({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState(() => loadActiveSessionDraft())

  if (!draft) {
    return children
  }

  const latestShot = draft.shots[0]
  const source = draft.metadata?.source ?? 'gspro'
  const feed = source === 'mock' ? 'mock' : 'real'

  const resumeSession = () => {
    const params = new URLSearchParams({ source, feed })
    if (latestShot?.club) {
      params.set('club', latestShot.club)
    }
    params.set('variant', latestShot?.shotVariantId?.trim() || 'stock')
    window.history.pushState({}, '', `/session-intelligence?${params.toString()}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  const startFresh = () => {
    clearActiveSessionDraft()
    setDraft(null)
  }

  return (
    <main className="looper-auth">
      <section className="looper-auth__card">
        <span className="looper-auth__eyebrow">The Looper</span>
        <h1>Resume your range session?</h1>
        <p className="looper-auth__lead">
          Looper saved your interrupted session with {draft.shots.length} shot{draft.shots.length === 1 ? '' : 's'}.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button className="looper-auth__primary" onClick={resumeSession} type="button">
            Resume Session
          </button>
          <button className="looper-auth__secondary" onClick={startFresh} type="button">
            Discard &amp; Start New
          </button>
        </div>
      </section>
    </main>
  )
}

function LiveGsproRoundArchiveBridge() {
  useEffect(() => {
    const stopArchive = startLiveGsproCourseRoundArchiver()
    const stopLineage = startLiveCaddieShotLineage()
    const stopTeeValidator = startLiveCaddieRoundTeeValidator()
    return () => {
      stopTeeValidator()
      stopLineage()
      stopArchive()
    }
  }, [])
  return null
}

function LiveCaddieRoundBootstrap({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return
    const timers = [600, 1600, 3000].map((delay) => window.setTimeout(() => {
      const round = loadActiveLiveCaddieRound()
      if (round?.phase === 'armed') {
        startLiveCaddieRound()
      }
    }, delay))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [active])
  return null
}

function RootRouter() {
  const [pathname, setPathname] = useState(() => normalizePath(window.location.pathname))
  const [hasBagConfig, setHasBagConfig] = useState(() => hasSavedBagConfig())
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [keepLiveCaddieMounted, setKeepLiveCaddieMounted] = useState(() =>
    isLiveCaddiePath(window.location.pathname),
  )

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
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const target = event.target
      if (!(target instanceof Element)) return

      const anchor = target.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (anchor.target && anchor.target !== '_self') return
      if (anchor.hasAttribute('download')) return

      const rawHref = anchor.getAttribute('href')
      if (!rawHref || !rawHref.startsWith('/')) return

      const url = new URL(rawHref, window.location.origin)
      const next = `${url.pathname}${url.search}${url.hash}`
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
      if (next === current) return

      event.preventDefault()
      window.history.pushState({}, '', next)
      setPathname(normalizePath(url.pathname))
    }

    window.addEventListener('popstate', onPopState)
    document.addEventListener('click', onDocumentClick)
    const onBagConfigUpdated = () => {
      refreshBagConfigState()
      setHasBagConfig(hasSavedBagConfig())
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

  const showCourseRenderDev = pathname === '/dev/course-render'
  const showCourseGeometryDev = pathname === '/dev/course-geometry'
  const showGsproCourseAlignment = pathname === '/dev/gspro-course-alignment'
  const showAimLab = pathname === '/aim-lab' || pathname === '/dev/aim-lab'
  const showLiveCaddie = isLiveCaddiePath(pathname)
  const showDevLiveCaddie = pathname === '/dev/live-caddie'
  const showRoundSetup = pathname === '/round-setup' || pathname === '/new-round'
  const showLoadCourse = pathname === '/courses' || pathname === '/load-course'
  const showCaddieInputs = pathname === '/caddie-inputs' || pathname === '/dev/caddie-inputs'
  const showGsproReplay = pathname === '/dev/gspro-replay'
  const showDecisionReplay = pathname === '/dev/decision-replay'
  const showDecisionAudit = pathname === '/dev/decision-audit'
  const showOcrTest = pathname === '/ocr-test' || pathname === '/dev/ocr-test'
  const showDevPage = showCourseRenderDev || showCourseGeometryDev || showGsproCourseAlignment || showAimLab || showDevLiveCaddie || showCaddieInputs || showGsproReplay || showDecisionReplay || showDecisionAudit || showOcrTest

  useEffect(() => {
    if (showLiveCaddie) {
      setKeepLiveCaddieMounted(true)
    }
  }, [showLiveCaddie])

  const view = useMemo(() => {
    const showSignOut = pathname === '/signout'
    const showBagSetup = pathname === '/bag-setup'
    const showShotVariants = pathname === '/edit-bag/variants'
    const showLooperLanding = pathname === '/' || pathname === '/looper'
    const showSessionSummary = pathname === '/session-summary' || pathname === '/sessionsummary'
    const showSessionIntelligence = pathname === '/session-intelligence'
    const showDashboardRoute = pathname === '/dashboard'
    const showTheRead = pathname === '/read'
    const showRounds = pathname === '/rounds' || pathname.startsWith('/rounds/')
    const showDataManagement = pathname === '/data-management' || pathname === '/manage-data'
    const showAdminUsers = pathname === '/admin/users'
    const showCloudRepair = pathname === '/cloud-repair'

    if (showCourseRenderDev) return <CourseRenderDevPage />
    if (showCourseGeometryDev) return <CourseGeometryDevPage />
    if (showGsproCourseAlignment) return <GsproMarkerAlignmentLab />
    if (showAimLab) return <AimLabPage />
    if (showLiveCaddie) return null
    if (showRoundSetup) return <RoundSetupPage />
    if (showLoadCourse) return <LoadCoursePage />
    if (showCaddieInputs) return <CaddieInputsPage />
    if (showGsproReplay) return <GsproReplayDevPage />
    if (showDecisionReplay) return <DecisionReplayDevPage />
    if (showDecisionAudit) return <DecisionAuditDevPage />
    if (showOcrTest) return <OcrTestPage />
    if (showSignOut) return <SignOutPage />
    if (showAdminUsers) return <AdminUsersPage />
    if (showCloudRepair) return <CloudRepairPage />
    if (showBagSetup || !hasBagConfig) return <BagSetupPage />
    if (showShotVariants) return <ShotVariantsPage />
    if (showSessionSummary) return <SessionSummaryPage />
    if (showDataManagement) return <DataManagementPage />
    if (showSessionIntelligence) return <SessionIntelligencePage />
    if (showTheRead) return <TheReadPage />
    if (showRounds) return <RoundsPage pathname={pathname} />
    if (showLooperLanding) {
      return (
        <InterruptedSessionGate>
          <LooperLandingPage
            installAvailableUpdate={installAvailableUpdate}
            updateError={updateError}
            updateStatus={updateStatus}
            onRetryUpdateCheck={checkForUpdates}
          />
        </InterruptedSessionGate>
      )
    }
    return <App forceDashboardRoute={showDashboardRoute} />
  }, [
    checkForUpdates,
    hasBagConfig,
    installAvailableUpdate,
    pathname,
    showAimLab,
    showCaddieInputs,
    showCourseGeometryDev,
    showGsproCourseAlignment,
    showCourseRenderDev,
    showDecisionAudit,
    showDecisionReplay,
    showGsproReplay,
    showLiveCaddie,
    showOcrTest,
    showRoundSetup,
    updateError,
    updateStatus,
  ])

  const normalContent = (
    <>
      {keepLiveCaddieMounted ? (
        <div style={{ display: showLiveCaddie ? 'contents' : 'none' }} aria-hidden={!showLiveCaddie}>
          <LiveCaddiePage />
        </div>
      ) : null}
      <LiveCaddieRoundBootstrap active={showLiveCaddie} />
      {!showLiveCaddie ? view : null}
    </>
  )

  return (
    <LooperAuthGate>
      <LiveGsproRoundArchiveBridge />
      {showDevPage && !showLiveCaddie
        ? view
        : <BrowserGsproSetupGate>{normalContent}</BrowserGsproSetupGate>}
    </LooperAuthGate>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootRouter />
  </StrictMode>,
)
