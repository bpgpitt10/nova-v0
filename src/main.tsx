import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LooperLandingPage from './pages/LooperLandingPage.tsx'
import SessionSummaryPage from './pages/SessionSummaryPage.tsx'
import SessionIntelligencePage from './pages/SessionIntelligencePage.tsx'
import DataManagementPage from './pages/DataManagementPage.tsx'

const normalizePath = (value: string) => value.replace(/\/+$/, '') || '/'

function RootRouter() {
  const [pathname, setPathname] = useState(() => normalizePath(window.location.pathname))

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

    return () => {
      window.removeEventListener('popstate', onPopState)
      document.removeEventListener('click', onDocumentClick)
    }
  }, [])

  const view = useMemo(() => {
    const showLooperLanding = pathname === '/looper'
    const showSessionSummary = pathname === '/session-summary' || pathname === '/sessionsummary'
    const showSessionIntelligence = pathname === '/session-intelligence'
    const showDashboardRoute = pathname === '/dashboard'
    const showDataManagement = pathname === '/data-management' || pathname === '/manage-data'

    if (showSessionSummary) {
      return <SessionSummaryPage />
    }
    if (showDataManagement) {
      return <DataManagementPage />
    }
    if (showSessionIntelligence) {
      return <SessionIntelligencePage />
    }
    if (showLooperLanding) {
      return <LooperLandingPage />
    }
    return <App forceDashboardRoute={showDashboardRoute} />
  }, [pathname])

  return view
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootRouter />
  </StrictMode>,
)
