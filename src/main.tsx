import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LooperLandingPage from './pages/LooperLandingPage.tsx'
import SessionSummaryPage from './pages/SessionSummaryPage.tsx'

const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
const showLooperLanding = import.meta.env.DEV && pathname === '/looper'
const showSessionSummary = pathname === '/session-summary' || pathname === '/sessionsummary'
const showDashboardRoute = pathname === '/dashboard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {showSessionSummary ? (
      <SessionSummaryPage />
    ) : showLooperLanding ? (
      <LooperLandingPage />
    ) : (
      <App forceDashboardRoute={showDashboardRoute} />
    )}
  </StrictMode>,
)
