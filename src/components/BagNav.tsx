import type { Club } from '../lib/bagConfig'
import looperLogoWhite from '../assets/LooperLogoWhite.png'
import '../pages/BagYardageBook.css'

export type BagNavTarget = 'bag' | 'lastSession' | 'club'

type BagTopBarProps = {
  active: BagNavTarget
  onBag: () => void
  onLastSession: () => void
  editBagHref: string
}

/** Slim top bar that replaces the dashboard rail when the yardage book is on. */
export function BagTopBar({ active, onBag, onLastSession, editBagHref }: BagTopBarProps) {
  return (
    <header className="bagbook-topbar">
      <a aria-label="Go to Looper home" className="bagbook-topbar-logo" href="/looper">
        <img alt="The Looper" src={looperLogoWhite} />
      </a>
      <nav aria-label="Dashboard navigation">
        <button
          aria-current={active === 'bag' || active === 'club' ? 'page' : undefined}
          className={active === 'bag' || active === 'club' ? 'is-active' : undefined}
          onClick={onBag}
          type="button"
        >
          Bag
        </button>
        <button
          aria-current={active === 'lastSession' ? 'page' : undefined}
          className={active === 'lastSession' ? 'is-active' : undefined}
          onClick={onLastSession}
          type="button"
        >
          Last Session
        </button>
      </nav>
      <div className="bagbook-topbar-actions">
        <a href={editBagHref}>Edit Bag</a>
        <a className="is-primary" href="/looper">
          New Session
        </a>
      </div>
    </header>
  )
}

type ClubSwitcherProps = {
  clubs: Array<{ club: Club; label: string }>
  current: Club
  onSelect: (club: Club) => void
  onBack: () => void
}

/** Club Detail header: back to the bag, pick a club, or step through in bag order. */
export function ClubSwitcher({ clubs, current, onSelect, onBack }: ClubSwitcherProps) {
  const index = clubs.findIndex((entry) => entry.club === current)
  const previous = index > 0 ? clubs[index - 1] : null
  const next = index >= 0 && index < clubs.length - 1 ? clubs[index + 1] : null
  return (
    <div className="bagbook-switcher">
      <button className="bagbook-switcher-back" onClick={onBack} type="button">
        ← Bag
      </button>
      <label>
        Club
        <select
          onChange={(event) => onSelect(event.target.value as Club)}
          value={current}
        >
          {clubs.map((entry) => (
            <option key={entry.club} value={entry.club}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <span className="bagbook-switcher-step">
        <button
          aria-label={previous ? `Previous club: ${previous.label}` : 'No previous club'}
          disabled={!previous}
          onClick={() => previous && onSelect(previous.club)}
          type="button"
        >
          ‹
        </button>
        <button
          aria-label={next ? `Next club: ${next.label}` : 'No next club'}
          disabled={!next}
          onClick={() => next && onSelect(next.club)}
          type="button"
        >
          ›
        </button>
      </span>
    </div>
  )
}
