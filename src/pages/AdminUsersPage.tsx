import { useEffect, useState, type FormEvent } from 'react'
import {
  listAllowedUsersForAdmin,
  setAllowedUserEnabledForAdmin,
  upsertAllowedUserForAdmin,
} from '../cloud/adminUsers'
import type { AllowedUserRecord } from '../cloud/supabaseClient'
import './AdminUsersPage.css'

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AllowedUserRecord[]>([])
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = async () => {
    setLoading(true)
    setError(null)
    try {
      setUsers(await listAllowedUsersForAdmin())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const addUser = async (event: FormEvent) => {
    event.preventDefault()
    const normalized = email.trim().toLowerCase()
    if (!normalized) {
      return
    }

    setBusy(true)
    setError(null)
    try {
      await upsertAllowedUserForAdmin({
        email: normalized,
        displayName,
        enabled: true,
      })
      setEmail('')
      setDisplayName('')
      await reload()
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError))
    } finally {
      setBusy(false)
    }
  }

  const toggleUser = async (user: AllowedUserRecord) => {
    setBusy(true)
    setError(null)
    try {
      await setAllowedUserEnabledForAdmin(user.email, !user.enabled)
      await reload()
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="looper-admin-users">
      <section className="looper-admin-users__card">
        <div className="looper-admin-users__header">
          <div>
            <span className="looper-admin-users__eyebrow">Looper admin</span>
            <h1>Users</h1>
            <p>Add or disable the small set of people who can use Looper.</p>
          </div>
          <a href="/looper">Back to Looper</a>
        </div>

        <form className="looper-admin-users__form" onSubmit={(event) => void addUser(event)}>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="friend@example.com"
            required
          />
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Name (optional)"
          />
          <button type="submit" disabled={busy || !email.trim()}>
            Add user
          </button>
        </form>

        {error ? <div className="looper-admin-users__error">{error}</div> : null}

        {loading ? (
          <p>Loading users…</p>
        ) : (
          <div className="looper-admin-users__list">
            {users.map((user) => (
              <div className="looper-admin-users__row" key={user.email}>
                <div>
                  <strong>{user.display_name || user.email}</strong>
                  {user.display_name ? <span>{user.email}</span> : null}
                  <small>{user.is_admin ? 'Admin' : 'User'}</small>
                </div>
                <div className="looper-admin-users__actions">
                  <span className={user.enabled ? 'is-enabled' : 'is-disabled'}>
                    {user.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <button
                    type="button"
                    disabled={busy || user.is_admin}
                    onClick={() => void toggleUser(user)}
                    title={user.is_admin ? 'Admin accounts cannot be disabled here.' : undefined}
                  >
                    {user.enabled ? 'Disable' : 'Enable'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
