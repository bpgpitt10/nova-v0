import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import LiveShotStateDebugPage from './LiveShotStateDebugPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LiveShotStateDebugPage />
  </StrictMode>,
)
