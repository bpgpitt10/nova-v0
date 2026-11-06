import { useEffect, useMemo, useState } from 'react'
import { getActiveBagClubIds, getClubLabel, BAG_CONFIG_UPDATED_EVENT, type Club } from '../lib/bagConfig'
import {
  ANCHOR_CLUBS,
  BLEND_RULES,
  QUICK_BAG_CARRY_LIMITS,
  buildQuickBagPrior,
  quickBagInputProblem,
  type AnchorClub,
  type QuickBagAnchor,
  type ShotShape,
} from '../lib/quickBag'
import { loadQuickBagInput, measuredClubs, rangeSwingsByClub, saveQuickBag, skipQuickBag } from '../lib/quickBagStore'
import { loadSavedSessions } from '../lib/sessions'
import golfSceneDetailBackground from '../assets/Backgrounds/golfscenedetail.png'
import looperLogoWhite from '../assets/LooperLogo.webp'
import './QuickBagPage.css'
import { LooperTagline } from '../components/LooperTagline'

/**
 * Your starting bag: handicap, three carries with a shape, and Looper gaps the
 * rest. Shown once after the bag is chosen (skippable), and any time from the
 * Bag page. Every number here is a starting guess the range replaces.
 */

const DEFAULT_RETURN_PATH = '/looper'

const resolveReturnPath = () => {
  if (typeof window === 'undefined') return DEFAULT_RETURN_PATH
  const raw = new URLSearchParams(window.location.search).get('returnTo')?.trim()
  return raw && raw.startsWith('/') ? raw : DEFAULT_RETURN_PATH
}

const navigateWithinApp = (path: string) => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const ANCHOR_HELP: Record<AnchorClub, string> = {
  Driver: 'A normal drive, carry not total.',
  '7i': 'A full 7-iron from the fairway.',
  PW: 'A full pitching wedge.',
}

const SHAPE_LABELS = (_club: AnchorClub): Record<ShotShape, string> => ({
  draw: 'Draw',
  neutral: 'Straight',
  fade: 'Fade',
})

type Draft = {
  handicap: string
  handicapUnknown: boolean
  handed: 'right' | 'left'
  anchors: Record<AnchorClub, { carry: string; shape: ShotShape }>
  overrides: Partial<Record<Club, string>>
}

const draftFromSaved = (): Draft => {
  const saved = loadQuickBagInput()
  const anchor = (club: AnchorClub) => ({
    carry: saved ? String(Math.round(saved.anchors[club].carryYds)) : '',
    shape: saved?.anchors[club].shape ?? 'neutral',
  })
  const overrides: Partial<Record<Club, string>> = {}
  for (const [club, carry] of Object.entries(saved?.carryOverrides ?? {})) {
    if (typeof carry === 'number') overrides[club as Club] = String(Math.round(carry))
  }
  return {
    handicap: formatHandicap(saved?.handicap ?? null),
    handicapUnknown: saved ? saved.handicap == null : false,
    handed: saved?.handed ?? 'right',
    anchors: { Driver: anchor('Driver'), '7i': anchor('7i'), PW: anchor('PW') },
    overrides,
  }
}

const parseCarry = (value: string): number | null => {
  const n = Number(value)
  return value.trim() !== '' && Number.isFinite(n) ? n : null
}

/**
 * Handicap as typed: "14", "14.2", or a plus handicap "+2" (better than
 * scratch), which Looper keeps as −2. A typed "-3" is an ordinary 3 handicap
 * (Brian, 11/6: people write their handicap with a minus too; only a plus
 * means better than scratch). Null when empty or not a number.
 */
export const parseHandicap = (value: string): number | null => {
  const text = value.trim()
  if (text === '') return null
  const plus = text.startsWith('+')
  const n = Number(text.replace(/^[+-]/, ''))
  if (!Number.isFinite(n)) return null
  return plus ? -Math.abs(n) : Math.abs(n)
}

export const formatHandicap = (handicap: number | null): string =>
  handicap == null ? '' : handicap < 0 ? `+${Math.abs(handicap)}` : String(handicap)

export default function QuickBagPage() {
  const returnPath = useMemo(() => resolveReturnPath(), [])
  const [clubs, setClubs] = useState<Club[]>(() => getActiveBagClubIds())
  const [draft, setDraft] = useState<Draft>(() => draftFromSaved())
  const [showAdjust, setShowAdjust] = useState(() => Object.keys(draftFromSaved().overrides).length > 0)
  const [error, setError] = useState<string | null>(null)
  const isEdit = useMemo(() => loadQuickBagInput() != null, [])
  // Clubs the range has already settled: their numbers are the player's own
  // and a typed carry wouldn't change them (the prior has no weight left).
  const sessions = useMemo(() => loadSavedSessions(), [])
  const swings = useMemo(() => rangeSwingsByClub(sessions), [sessions])
  const measured = useMemo(() => new Set(measuredClubs(sessions, clubs)), [sessions, clubs])

  useEffect(() => {
    const refresh = () => setClubs(getActiveBagClubIds())
    window.addEventListener(BAG_CONFIG_UPDATED_EVENT, refresh)
    return () => window.removeEventListener(BAG_CONFIG_UPDATED_EVENT, refresh)
  }, [])

  const anchors = useMemo((): Partial<Record<AnchorClub, Partial<QuickBagAnchor>>> => ({
    Driver: { carryYds: parseCarry(draft.anchors.Driver.carry) ?? undefined, shape: draft.anchors.Driver.shape },
    '7i': { carryYds: parseCarry(draft.anchors['7i'].carry) ?? undefined, shape: draft.anchors['7i'].shape },
    PW: { carryYds: parseCarry(draft.anchors.PW.carry) ?? undefined, shape: draft.anchors.PW.shape },
  }), [draft.anchors])
  const problem = quickBagInputProblem(anchors)
  const anchorsEntered = ANCHOR_CLUBS.every((club) => parseCarry(draft.anchors[club].carry) != null)
  const handicap = draft.handicapUnknown ? null : parseHandicap(draft.handicap)

  const overrides = useMemo(() => {
    const out: Partial<Record<Club, number>> = {}
    for (const [club, value] of Object.entries(draft.overrides) as Array<[string, string | undefined]>) {
      const n = parseCarry(value ?? '')
      if (n != null) out[club as Club] = n
    }
    return out
  }, [draft.overrides])

  const preview = useMemo(() => {
    if (problem) return null
    return buildQuickBagPrior({
      version: 1,
      handicap,
      anchors: anchors as Record<AnchorClub, QuickBagAnchor>,
      clubs,
      carryOverrides: overrides,
      handed: draft.handed,
      savedAt: new Date().toISOString(),
    })
  }, [problem, handicap, anchors, clubs, overrides, draft.handed])

  const setAnchor = (club: AnchorClub, patch: Partial<{ carry: string; shape: ShotShape }>) =>
    setDraft((d) => ({ ...d, anchors: { ...d.anchors, [club]: { ...d.anchors[club], ...patch } } }))

  const save = () => {
    if (problem) {
      setError(problem)
      return
    }
    if (!draft.handicapUnknown && draft.handicap.trim() !== '' && handicap == null) {
      setError('Handicap should be a number like 14, or a plus handicap like +2.')
      return
    }
    if (!draft.handicapUnknown && handicap != null && (handicap < -10 || handicap > 54)) {
      setError('Handicap should be between +10 and 54, or tick "not sure".')
      return
    }
    saveQuickBag({
      handicap: handicap == null ? null : Math.min(36, Math.max(-10, handicap)),
      anchors: anchors as Record<AnchorClub, QuickBagAnchor>,
      clubs,
      carryOverrides: overrides,
      handed: draft.handed,
    })
    navigateWithinApp(returnPath)
  }

  const skip = () => {
    skipQuickBag()
    navigateWithinApp(returnPath)
  }

  return (
    <main
      className="quick-bag-page"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(9, 16, 11, 0.74), rgba(9, 16, 11, 0.93)), url(${golfSceneDetailBackground})`,
      }}
    >
      <section className="quick-bag-shell" aria-label="Your starting bag">
        <header className="quick-bag-header">
          <div>
            <img alt="The Looper" className="quick-bag-logo" src={looperLogoWhite} />
            <p className="quick-bag-eyebrow">{isEdit ? 'Starting bag' : 'One more thing'}</p>
            <h1>Your starting bag</h1>
            <p className="quick-bag-lead">
              Three carries and your handicap. Looper gaps the rest of your clubs, works out how wide you miss, and
              can caddie your first hole. Every range swing replaces a guess: a club is yours after {BLEND_RULES.carry.fullAt} good
              range swings.
            </p>
          </div>
        </header>

        <div className="quick-bag-grid">
          <section className="quick-bag-card">
            <h2>About you</h2>
            <div className="quick-bag-field-row">
              <label className="quick-bag-field">
                <span>Handicap</span>
                <input
                  disabled={draft.handicapUnknown}
                  inputMode="text"
                  onChange={(e) => setDraft((d) => ({ ...d, handicap: e.target.value }))}
                  pattern="\+?[0-9]+([.][0-9])?"
                  placeholder="e.g. 14"
                  type="text"
                  value={draft.handicap}
                />
              </label>
              <label className="quick-bag-check">
                <input
                  checked={draft.handicapUnknown}
                  onChange={(e) => setDraft((d) => ({ ...d, handicapUnknown: e.target.checked }))}
                  type="checkbox"
                />
                <span>Not sure (Looper assumes about 18)</span>
              </label>
            </div>
            <div className="quick-bag-field">
              <span>You play</span>
              <div className="quick-bag-segmented" role="radiogroup" aria-label="Handedness">
                {(['right', 'left'] as const).map((hand) => (
                  <button
                    aria-checked={draft.handed === hand}
                    className={draft.handed === hand ? 'is-on' : ''}
                    key={hand}
                    onClick={() => setDraft((d) => ({ ...d, handed: hand }))}
                    role="radio"
                    type="button"
                  >
                    {hand === 'right' ? 'Right-handed' : 'Left-handed'}
                  </button>
                ))}
              </div>
            </div>
            <p className="quick-bag-fine">
              Better than scratch? Type it with a plus, like <strong>+2</strong>. Handicap sets how wide the pattern is
              and how often a swing comes up short: a scratch player's 7-iron spreads about 4% of its carry, an 18
              handicap's about 7%.
            </p>
          </section>

          <section className="quick-bag-card">
            <h2>Three carries</h2>
            {ANCHOR_CLUBS.map((club) => {
              const labels = SHAPE_LABELS(club)
              const [lo, hi] = QUICK_BAG_CARRY_LIMITS[club]
              return (
                <div className="quick-bag-anchor" key={club}>
                  <div className="quick-bag-anchor-head">
                    <strong>{getClubLabel(club)}</strong>
                    <span>{ANCHOR_HELP[club]}</span>
                  </div>
                  <div className="quick-bag-anchor-controls">
                    <label className="quick-bag-field quick-bag-carry">
                      <span>Carry</span>
                      <span className="quick-bag-carry-input">
                        <input
                          inputMode="numeric"
                          max={hi}
                          min={lo}
                          onChange={(e) => setAnchor(club, { carry: e.target.value })}
                          placeholder={club === 'Driver' ? '230' : club === '7i' ? '150' : '115'}
                          type="number"
                          value={draft.anchors[club].carry}
                        />
                        <em>yd</em>
                      </span>
                    </label>
                    <div className="quick-bag-field">
                      <span>Shape</span>
                      <div className="quick-bag-segmented" role="radiogroup" aria-label={`${club} shape`}>
                        {(['draw', 'neutral', 'fade'] as const).map((shape) => (
                          <button
                            aria-checked={draft.anchors[club].shape === shape}
                            className={draft.anchors[club].shape === shape ? 'is-on' : ''}
                            key={shape}
                            onClick={() => setAnchor(club, { shape })}
                            role="radio"
                            type="button"
                          >
                            {labels[shape]}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </section>
        </div>

        <section className="quick-bag-card quick-bag-preview">
          <div className="quick-bag-preview-head">
            <h2>Your bag, gapped</h2>
            <span className="quick-bag-preview-sub">
              {clubs.length} clubs from your bag setup · <a href="/bag-setup?returnTo=/quick-bag">change clubs</a>
            </span>
            {preview ? (
              <button className="quick-bag-adjust" onClick={() => setShowAdjust((v) => !v)} type="button">
                {showAdjust ? 'Done adjusting' : 'Adjust any club'}
              </button>
            ) : null}
          </div>
          {preview ? (
            <div className="quick-bag-table" role="table">
              <div className="quick-bag-trow quick-bag-thead" role="row">
                <span role="columnheader">Club</span>
                <span role="columnheader">Carry</span>
                <span role="columnheader">Total</span>
                <span role="columnheader">Side to side (±)</span>
                <span role="columnheader">Bias</span>
                <span role="columnheader">Short swings</span>
              </div>
              {preview.clubs.map((row) => {
                const isAnchor = (ANCHOR_CLUBS as readonly string[]).includes(row.club)
                const overridden = draft.overrides[row.club] != null && draft.overrides[row.club] !== ''
                const isMeasured = measured.has(row.club)
                const swingCount = swings.get(row.club) ?? 0
                return (
                  <div className={`quick-bag-trow${isAnchor ? ' is-anchor' : ''}${overridden ? ' is-typed' : ''}${isMeasured ? ' is-measured' : ''}`} key={row.club} role="row">
                    <span role="cell">
                      <strong>{getClubLabel(row.club)}</strong>
                      {isMeasured ? <em> range, {swingCount} swings</em>
                        : swingCount > 0 ? <em> learning {swingCount}/{BLEND_RULES.carry.fullAt}</em>
                          : isAnchor ? <em> yours</em> : overridden ? <em> typed</em> : null}
                    </span>
                    <span role="cell">
                      {showAdjust && !isAnchor && !isMeasured ? (
                        <span className="quick-bag-carry-input is-small">
                          <input
                            inputMode="numeric"
                            onChange={(e) => setDraft((d) => ({ ...d, overrides: { ...d.overrides, [row.club]: e.target.value } }))}
                            placeholder={String(row.carryYds)}
                            type="number"
                            value={draft.overrides[row.club] ?? ''}
                          />
                          <em>yd</em>
                        </span>
                      ) : (
                        <strong>{row.carryYds}</strong>
                      )}
                    </span>
                    <span role="cell">{row.totalYds}</span>
                    <span role="cell">±{Math.round(row.lateralSigmaYds)} yd</span>
                    <span role="cell">
                      {row.lateralBiasYds === 0 ? 'straight' : `${Math.abs(Math.round(row.lateralBiasYds))} yd ${row.lateralBiasYds < 0 ? 'left' : 'right'}`}
                    </span>
                    <span role="cell">{Math.round(row.mishitRate * 100)}%</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="quick-bag-waiting">
              {anchorsEntered
                ? problem
                : 'Type your three carries above and your whole bag appears here, gapped, with a carry you can change on any club.'}
            </p>
          )}
          {showAdjust && preview && measured.size > 0 ? (
            <p className="quick-bag-fine">
              Clubs marked “range” have {BLEND_RULES.carry.fullAt}+ good swings: their numbers come from your swings
              and typing here wouldn't change them. Starting numbers only fill in until the range takes over.
            </p>
          ) : null}
          {showAdjust && Object.keys(draft.overrides).length > 0 ? (
            <button className="quick-bag-reset" onClick={() => setDraft((d) => ({ ...d, overrides: {} }))} type="button">
              Clear typed carries
            </button>
          ) : null}
        </section>

        {error ? <p className="quick-bag-error" role="alert">{error}</p> : null}

        <footer className="quick-bag-actions">
          <button className="quick-bag-save" disabled={Boolean(problem)} onClick={save} type="button">
            {isEdit ? 'Save starting bag' : 'Save and start'}
          </button>
          {!isEdit ? (
            <button className="quick-bag-skip" onClick={skip} type="button">
              Skip — I'll build my bag on the range
            </button>
          ) : (
            <a className="quick-bag-skip" href={returnPath}>Back</a>
          )}
        </footer>
        <LooperTagline />
      </section>
    </main>
  )
}
