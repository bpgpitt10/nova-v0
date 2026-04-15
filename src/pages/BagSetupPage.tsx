import { useMemo, useState } from 'react'
import {
  bagSetupSections,
  getClubLabel,
  loadBagConfig,
  saveBagConfig,
  sortClubIds,
  type Club,
} from '../lib/bagConfig'
import golfSceneDetailBackground from '../assets/Backgrounds/golfscenedetail.png'
import looperLogoWhite from '../assets/LooperLogoWhite.png'
import './BagSetupPage.css'

const DEFAULT_RETURN_PATH = '/looper'

const resolveReturnPath = () => {
  if (typeof window === 'undefined') {
    return DEFAULT_RETURN_PATH
  }
  const query = new URLSearchParams(window.location.search)
  const raw = query.get('returnTo')?.trim()
  return raw && raw.startsWith('/') ? raw : DEFAULT_RETURN_PATH
}

const navigateWithinApp = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function BagSetupPage() {
  const returnPath = useMemo(() => resolveReturnPath(), [])
  const [selected, setSelected] = useState<Set<Club>>(() => {
    const saved = loadBagConfig()
    return saved ? new Set(saved.selectedClubs) : new Set()
  })

  const selectedCount = selected.size

  const toggleClub = (club: Club) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(club)) {
        next.delete(club)
      } else {
        next.add(club)
      }
      return next
    })
  }

  const saveBag = () => {
    if (selectedCount === 0) {
      return
    }
    saveBagConfig(sortClubIds(Array.from(selected)))
    navigateWithinApp(returnPath)
  }

  return (
    <main
      className="bag-setup-page"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(9, 16, 11, 0.72), rgba(9, 16, 11, 0.92)), url(${golfSceneDetailBackground})`,
      }}
    >
      <section className="bag-setup-shell" aria-label="Bag setup">
        <header className="bag-setup-header">
          <div className="bag-setup-header-top">
            <h1>Choose Your Bag</h1>
            <button
              className="bag-setup-save"
              disabled={selectedCount === 0}
              onClick={saveBag}
              type="button"
            >
              Save Bag
            </button>
          </div>
          <img alt="The Looper" className="bag-setup-logo" src={looperLogoWhite} />
          <p>{selectedCount} clubs selected</p>
          <p className="bag-setup-nudge">Most players carry 13 clubs (+ putter to make 14)</p>
        </header>

        <div className="bag-setup-sections">
          {bagSetupSections.map((section) => (
            <article className="bag-setup-section" key={section.title}>
              <h2>{section.title}</h2>
              <div className="bag-setup-club-grid">
                {section.clubs.map((club) => {
                  const checked = selected.has(club)
                  return (
                    <label className={`bag-setup-club ${checked ? 'is-selected' : ''}`} key={club}>
                      <input
                        checked={checked}
                        onChange={() => toggleClub(club)}
                        type="checkbox"
                      />
                      <span>{getClubLabel(club)}</span>
                    </label>
                  )
                })}
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
