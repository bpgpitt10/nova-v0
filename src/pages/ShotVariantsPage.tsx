import { useMemo, useState } from 'react'
import {
  getActiveBagClubIds,
  getClubDisplayName,
  saveBagConfig,
  sortClubIds,
  type Club,
} from '../lib/bagConfig'
import {
  getCustomShotVariants,
  saveCustomShotVariants,
  type ShotVariant,
} from '../lib/shotVariants'
import golfSceneDetailBackground from '../assets/Backgrounds/golfscenedetail.png'
import looperLogoWhite from '../assets/LooperLogoWhite.png'
import './ShotVariantsPage.css'

const formatVariantName = (name: string) =>
  name.length > 24 ? `${name.slice(0, 21)}...` : name

const newVariantId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `variant-${Date.now()}`

const navigateWithinApp = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function ShotVariantsPage() {
  const clubs = useMemo(() => getActiveBagClubIds(), [])
  const [variants, setVariants] = useState<ShotVariant[]>(() => getCustomShotVariants())
  const [selectedClub, setSelectedClub] = useState<Club>(() => clubs[0] ?? '7i')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const persistVariants = (nextVariants: ShotVariant[]) => {
    setVariants(nextVariants)
    saveCustomShotVariants(nextVariants)
  }

  const addVariant = () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Variant name is required.')
      return
    }

    const normalizedName = trimmedName.toLowerCase()
    const duplicateExists =
      normalizedName === 'stock' ||
      variants.some(
        (variant) =>
          (!variant.club || variant.club === selectedClub) &&
          variant.name.trim().toLowerCase() === normalizedName,
      )

    if (duplicateExists) {
      setError('That variant already exists for this club.')
      return
    }

    persistVariants([
      ...variants,
      {
        id: newVariantId(),
        club: selectedClub,
        name: trimmedName,
      },
    ])
    setName('')
    setError(null)
  }

  const deleteVariant = (variantId: string) => {
    persistVariants(variants.filter((variant) => variant.id !== variantId))
  }

  const saveBag = () => {
    saveBagConfig(sortClubIds(clubs))
    navigateWithinApp('/looper')
  }

  return (
    <main
      className="shot-variants-page"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(9, 16, 11, 0.72), rgba(9, 16, 11, 0.92)), url(${golfSceneDetailBackground})`,
      }}
    >
      <section className="shot-variants-shell" aria-label="Shot variants">
        <header className="shot-variants-header">
          <div className="shot-variants-header-top">
            <h1>Shot Variants</h1>
            <a className="shot-variants-back" href="/bag-setup">
              Edit Bag
            </a>
            <button className="shot-variants-save" onClick={saveBag} type="button">
              Save Bag
            </button>
          </div>
          <img alt="The Looper" className="shot-variants-logo" src={looperLogoWhite} />
          <p>Stock is always available. Add custom variants for the clubs in your bag.</p>
        </header>

        <section className="shot-variants-form" aria-label="Add shot variant">
          <div className="shot-variants-field">
            <label htmlFor="shot-variant-club">Club</label>
            <select
              id="shot-variant-club"
              onChange={(event) => setSelectedClub(event.target.value as Club)}
              value={selectedClub}
            >
              {clubs.map((club) => (
                <option key={club} value={club}>
                  {getClubDisplayName(club)}
                </option>
              ))}
            </select>
          </div>
          <div className="shot-variants-field">
            <label htmlFor="shot-variant-name">Name</label>
            <input
              id="shot-variant-name"
              maxLength={32}
              onChange={(event) => setName(event.target.value)}
              placeholder="Fade, Knockdown, Tee ball..."
              type="text"
              value={name}
            />
          </div>
          <button className="shot-variants-add" onClick={addVariant} type="button">
            Add Variant
          </button>
          {error ? <p className="shot-variants-error">{error}</p> : null}
        </section>

        <div className="shot-variants-clubs">
          {clubs.map((club) => {
            const clubVariants = variants.filter((variant) => variant.club === club)
            return (
              <article className="shot-variants-club" key={club}>
                <h2>{getClubDisplayName(club)}</h2>
                <div className="shot-variants-list">
                  <div className="shot-variants-row">
                    <span title="Stock">{formatVariantName('Stock')}</span>
                    <span className="shot-variants-built-in">Built in</span>
                  </div>
                  {clubVariants.map((variant) => (
                    <div className="shot-variants-row" key={variant.id}>
                      <span title={variant.name}>{formatVariantName(variant.name)}</span>
                      <button
                        className="shot-variants-delete"
                        onClick={() => deleteVariant(variant.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                  {clubVariants.length === 0 ? (
                    <p className="shot-variants-empty">No custom variants yet.</p>
                  ) : null}
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </main>
  )
}
