import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LooperLandingPage from './pages/LooperLandingPage.tsx'
import SessionSummaryPage from './pages/SessionSummaryPage.tsx'
import SessionIntelligencePage from './pages/SessionIntelligencePage.tsx'
import DataManagementPage from './pages/DataManagementPage.tsx'

const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
const showLooperLanding = import.meta.env.DEV && pathname === '/looper'
const showSessionSummary = pathname === '/session-summary' || pathname === '/sessionsummary'
const showSessionIntelligence = pathname === '/session-intelligence'
const showDashboardRoute = pathname === '/dashboard'
const showDataManagement = pathname === '/data-management' || pathname === '/manage-data'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {showSessionSummary ? (
      <SessionSummaryPage />
    ) : showDataManagement ? (
      <DataManagementPage />
    ) : showSessionIntelligence ? (
      <SessionIntelligencePage />
    ) : showLooperLanding ? (
      <LooperLandingPage />
    ) : (
      <App forceDashboardRoute={showDashboardRoute} />
    )}
  </StrictMode>,
)
