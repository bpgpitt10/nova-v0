import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import LooperLandingPage from './pages/LooperLandingPage.tsx'

const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
const showLooperLanding = import.meta.env.DEV && pathname === '/looper'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {showLooperLanding ? <LooperLandingPage /> : <App />}
  </StrictMode>,
)
