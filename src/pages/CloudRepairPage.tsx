import { useEffect, useState } from 'react'
import {
  getAllowedUserRecord,
  getCurrentLooperUser,
} from '../cloud/supabaseClient'
import {
  loadDefaultBagFromCloud,
  loadSavedSessionsFromCloud,
} from '../cloud/cloudPersistence'
import { loadBagConfig, saveBagConfig } from '../lib/bagConfig'
import { loadSavedSessions, saveSessionHistory } from '../lib/sessions'

type RepairState =
  | { status: 'loading' }
  | {
      status: 'ready'
      email: string
      localSessions: number
      localShots: number
      cloudSessions: number
      cloudShots: number
      repaired: boolean
      bagRecovered: boolean
    }
  | { status: 'error'; message: string }

const countShots = (sessions: ReturnType<typeof loadSavedSessions>) =>
  sessions.reduce((sum, session) => sum + session.shots.length, 0)

export default function CloudRepairPage() {
  const [state, setState] = useState<RepairState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        const user = await getCurrentLooperUser()
        if (!user) {
          throw new Error('No signed-in Looper account was found in this browser.')
        }

        const allowed = await getAllowedUserRecord(user)
        if (!allowed) {
          throw new Error(`${user.email ?? 'This account'} is not on the Looper access list.`)
        }

        const localBefore = loadSavedSessions()
        const cloudSessions = await loadSavedSessionsFromCloud()
        const localBeforeShots = countShots(localBefore)
        const cloudShots = countShots(cloudSessions)

        // Repair the browser cache from the account copy. Preserve any local-only
        // sessions, while letting the cloud copy fill/replace matching session ids.
        const mergedById = new Map(localBefore.map((session) => [session.id, session]))
        cloudSessions.forEach((session) => mergedById.set(session.id, session))
        const merged = Array.from(mergedById.values()).sort((a, b) =>
          b.startedAt.localeCompare(a.startedAt),
        )
        const repaired = JSON.stringify(merged) !== JSON.stringify(localBefore)
        if (repaired) {
          saveSessionHistory(merged)
        }

        let bagRecovered = false
        if (!loadBagConfig()) {
          const cloudBag = await loadDefaultBagFromCloud()
          if (cloudBag?.length) {
            saveBagConfig(cloudBag)
            bagRecovered = true
          }
        }

        const localAfter = loadSavedSessions()
        if (!cancelled) {
          setState({
            status: 'ready',
            email: user.email ?? 'signed-in account',
            localSessions: localAfter.length,
            localShots: countShots(localAfter),
            cloudSessions: cloudSessions.length,
            cloudShots,
            repaired: repaired || localBeforeShots !== countShots(localAfter),
            bagRecovered,
          })
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0b0d0c',
        color: '#f5f3ed',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <section
        style={{
          width: 'min(560px, 100%)',
          border: '1px solid rgba(255,255,255,.15)',
          borderRadius: 18,
          padding: 24,
          background: '#151817',
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: '.16em', opacity: 0.65 }}>THE LOOPER</div>
        <h1 style={{ margin: '10px 0 8px', fontSize: 28 }}>Cloud data repair</h1>

        {state.status === 'loading' ? <p>Checking your account data…</p> : null}

        {state.status === 'error' ? (
          <>
            <p style={{ color: '#ffb4ab' }}>Repair stopped: {state.message}</p>
            <p style={{ opacity: 0.72 }}>Send me a screenshot of this page and I can fix the exact failing step.</p>
          </>
        ) : null}

        {state.status === 'ready' ? (
          <>
            <p style={{ marginBottom: 18 }}>
              Signed in as <strong>{state.email}</strong>.
            </p>
            <div style={{ display: 'grid', gap: 8, marginBottom: 20 }}>
              <div>Cloud: <strong>{state.cloudSessions}</strong> session · <strong>{state.cloudShots}</strong> shots</div>
              <div>Browser cache: <strong>{state.localSessions}</strong> session · <strong>{state.localShots}</strong> shots</div>
              <div>Bag recovered: <strong>{state.bagRecovered ? 'yes' : 'already present'}</strong></div>
            </div>
            {state.cloudShots > 0 && state.localShots === state.cloudShots ? (
              <p style={{ color: '#b9f6ca' }}>
                Your cloud history is now in this browser{state.repaired ? ' and was repaired successfully' : ''}.
              </p>
            ) : (
              <p style={{ color: '#ffd8a8' }}>
                The counts do not match yet. Leave this page as-is and send me a screenshot.
              </p>
            )}
            <a
              href="/dashboard"
              style={{
                display: 'inline-block',
                marginTop: 12,
                padding: '12px 16px',
                borderRadius: 10,
                background: '#f5f3ed',
                color: '#111',
                textDecoration: 'none',
                fontWeight: 700,
              }}
            >
              Open Dashboard
            </a>
          </>
        ) : null}
      </section>
    </main>
  )
}
