import App from '../App'
import ShotReviewPanel from '../components/ShotReviewPanel'
import './SessionIntelligencePage.css'

function SessionIntelligencePage() {
  const showMishitReview =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mishitReview') === '1'

  return (
    <div className="session-intelligence-page">
      <App forceSessionIntelligenceRoute />
      {showMishitReview ? <ShotReviewPanel /> : null}
    </div>
  )
}

export default SessionIntelligencePage
