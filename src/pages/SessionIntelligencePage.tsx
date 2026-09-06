import App from '../App'
import ShotReviewPanel from '../components/ShotReviewPanel'
import './SessionIntelligencePage.css'

function SessionIntelligencePage() {
  return (
    <div className="session-intelligence-page">
      <App forceSessionIntelligenceRoute />
      <ShotReviewPanel />
    </div>
  )
}

export default SessionIntelligencePage
