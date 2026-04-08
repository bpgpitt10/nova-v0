import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LooperLandingPage from './pages/LooperLandingPage.tsx'
import SessionSummaryPage from './pages/SessionSummaryPage.tsx'
import SessionIntelligencePage from './pages/SessionIntelligencePage.tsx'

const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
const showLooperLanding = import.meta.env.DEV && pathname === '/looper'
const showSessionSummary = pathname === '/session-summary' || pathname === '/sessionsummary'
const showSessionIntelligence = pathname === '/session-intelligence'
const showDashboardRoute = pathname === '/dashboard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {showSessionSummary ? (
      <SessionSummaryPage />
    ) : showSessionIntelligence ? (
      <SessionIntelligencePage />
    ) : showLooperLanding ? (
      <LooperLandingPage />
    ) : (
      <App forceDashboardRoute={showDashboardRoute} />
    )}
  </StrictMode>,
)
