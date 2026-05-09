import { useEffect, useMemo, useRef, useState } from 'react'
import theReadLogo from '../assets/the-read-logo.png'
import { getClubLabel, type Club } from '../lib/bagConfig'
import {
  isSessionEligibleForAnalysis,
  isSessionIncludedInAnalysis,
  loadSavedSessions,
} from '../lib/sessions'
import { getShotVariantLabel, resolveShotVariantId } from '../lib/shotVariants'
import type { OpenGolfCoachPayload, Shot } from '../types'
import './TheReadPage.css'

const LADDER_MIN_YARDAGE = 30
const LADDER_MAX_YARDAGE = 320
const BASE_TICK_SPACING = 72
const SHOT_MARKER_VERTICAL_SPACE = 44
const WHEEL_STEP_THRESHOLD = 110
const TARGET_LINE_Y_PERCENT = 50
const YARDAGE_PERCENT_PER_YARD = 1.2
type ShotMode = 'stock' | 'pure'
type SelectedMetric = 'carry' | 'total'

const ladderMarks = Array.from(
  { length: (LADDER_MAX_YARDAGE - LADDER_MIN_YARDAGE) / 10 + 1 },
  (_, index) => LADDER_MIN_YARDAGE + index * 10,
)

const readOptions = [
  {
    label: 'Short',
    club: 'SW',
    variant: 'Soft',
    score: '91 (Play)',
    stock: {
      left: '34%',
      width: '86px',
      height: '46px',
      rotate: '-10deg',
      carry: 82,
      total: 84,
      stats: {
        carry: ['82 yd', '-6'],
        total: ['84 yd', '-5'],
        offline: ['5.8 L', '-1.4'],
        launch: ['31.2°', '+2.1'],
        hla: ['1.8 L', '-0.5'],
        spin: ['8420', '+340'],
        spinAxis: ['6.4 L', '-1.1'],
        smash: ['1.19', '-0.02'],
        ballSpeed: ['72 mph', '-3'],
        clubSpeed: ['65 mph', '-1'],
        peak: ['72 ft', '+5'],
        descent: ['47°', '+3'],
        clubPath: ['1.2 R', '+0.4'],
        faceToPath: ['0.8 L', '-0.2'],
        faceToTarget: ['1.9 L', '-0.4'],
        ogcShotName: ['Soft wedge', ''],
        ogcRank: ['A-', '+4'],
      },
    },
    pure: {
      left: '40%',
      width: '58px',
      height: '32px',
      rotate: '-6deg',
      carry: 84,
      total: 86,
      stats: {
        carry: ['84 yd', '-2'],
        total: ['86 yd', '-2'],
        offline: ['2.1 L', '+2.3'],
        launch: ['30.4°', '+1.3'],
        hla: ['0.7 L', '+0.6'],
        spin: ['8160', '+80'],
        spinAxis: ['2.0 L', '+3.3'],
        smash: ['1.21', '0.00'],
        ballSpeed: ['74 mph', '-1'],
        clubSpeed: ['66 mph', '0'],
        peak: ['69 ft', '+2'],
        descent: ['45°', '+1'],
        clubPath: ['0.6 R', '-0.2'],
        faceToPath: ['0.2 L', '+0.4'],
        faceToTarget: ['0.6 L', '+0.9'],
        ogcShotName: ['Soft wedge', ''],
        ogcRank: ['A', '+7'],
      },
    },
  },
  {
    label: 'Target',
    club: 'GW',
    variant: 'Flighted',
    score: '91 (Play)',
    stock: {
      left: '30%',
      width: '102px',
      height: '40px',
      rotate: '7deg',
      carry: 90,
      total: 93,
      stats: {
        carry: ['90 yd', '+1'],
        total: ['93 yd', '+2'],
        offline: ['3.0 R', '+1.2'],
        launch: ['27.8°', '+0.4'],
        hla: ['0.9 R', '+0.2'],
        spin: ['7620', '-120'],
        spinAxis: ['3.8 R', '+0.7'],
        smash: ['1.24', '+0.01'],
        ballSpeed: ['78 mph', '+1'],
        clubSpeed: ['69 mph', '0'],
        peak: ['74 ft', '+3'],
        descent: ['44°', '+1'],
        clubPath: ['1.7 R', '+0.5'],
        faceToPath: ['0.3 L', '+0.3'],
        faceToTarget: ['0.5 R', '+0.5'],
        ogcShotName: ['Flighted gap', ''],
        ogcRank: ['A', '+8'],
      },
    },
    pure: {
      left: '42%',
      width: '60px',
      height: '28px',
      rotate: '4deg',
      carry: 91,
      total: 94,
      stats: {
        carry: ['91 yd', '0'],
        total: ['94 yd', '0'],
        offline: ['0.8 R', '+3.4'],
        launch: ['27.1°', '-0.3'],
        hla: ['0.2 R', '+0.9'],
        spin: ['7710', '-30'],
        spinAxis: ['1.1 R', '+3.4'],
        smash: ['1.25', '+0.02'],
        ballSpeed: ['79 mph', '+2'],
        clubSpeed: ['69 mph', '0'],
        peak: ['71 ft', '0'],
        descent: ['43°', '0'],
        clubPath: ['1.1 R', '-0.1'],
        faceToPath: ['0.1 R', '+0.7'],
        faceToTarget: ['0.3 R', '+0.7'],
        ogcShotName: ['Flighted gap', ''],
        ogcRank: ['A+', '+11'],
      },
    },
  },
  {
    label: 'Long',
    club: 'PW',
    variant: 'Stock',
    score: '91 (Play)',
    stock: {
      left: '40%',
      width: '78px',
      height: '58px',
      rotate: '14deg',
      carry: 115,
      total: 121,
      stats: {
        carry: ['115 yd', '+8'],
        total: ['121 yd', '+10'],
        offline: ['6.4 R', '-1.8'],
        launch: ['25.0°', '-2.0'],
        hla: ['2.2 R', '-0.8'],
        spin: ['6880', '-520'],
        spinAxis: ['7.2 R', '-2.0'],
        smash: ['1.28', '+0.03'],
        ballSpeed: ['86 mph', '+5'],
        clubSpeed: ['72 mph', '+2'],
        peak: ['67 ft', '-4'],
        descent: ['40°', '-3'],
        clubPath: ['2.4 R', '+1.2'],
        faceToPath: ['0.9 R', '-0.2'],
        faceToTarget: ['2.8 R', '-1.1'],
        ogcShotName: ['Stock wedge', ''],
        ogcRank: ['B+', '-2'],
      },
    },
    pure: {
      left: '34%',
      width: '54px',
      height: '36px',
      rotate: '8deg',
      carry: 113,
      total: 119,
      stats: {
        carry: ['113 yd', '+5'],
        total: ['119 yd', '+7'],
        offline: ['2.6 R', '+2.0'],
        launch: ['25.8°', '-1.2'],
        hla: ['0.8 R', '+0.6'],
        spin: ['7100', '-300'],
        spinAxis: ['2.4 R', '+2.8'],
        smash: ['1.27', '+0.02'],
        ballSpeed: ['85 mph', '+4'],
        clubSpeed: ['72 mph', '+2'],
        peak: ['69 ft', '-2'],
        descent: ['41°', '-2'],
        clubPath: ['1.8 R', '+0.6'],
        faceToPath: ['0.2 R', '+0.5'],
        faceToTarget: ['1.0 R', '+0.7'],
        ogcShotName: ['Stock wedge', ''],
        ogcRank: ['A-', '+3'],
      },
    },
  },
]

const inspectorRows = [
  ['Carry', 'carry', 10, 0],
  ['Total Distance', 'total', 9, 0],
  ['Offline', 'offline', 8, 0],
  ['Launch / VLA', 'launch', 1.2, 1],
  ['Start Line / HLA', 'hla', 1.1, 1],
  ['Spin', 'spin', 189, 0],
  ['Spin Axis', 'spinAxis', 4.2, 1],
  ['Smash Factor', 'smash', 0.02, 2],
  ['Ball Speed', 'ballSpeed', 4, 0],
  ['Club Speed', 'clubSpeed', 3, 0],
  ['Peak Height', 'peak', 7, 0],
  ['Descent Angle', 'descent', 3, 0],
  ['Club Path', 'clubPath', 1.3, 1],
  ['Face to Path', 'faceToPath', 0.8, 1],
  ['Face to Target', 'faceToTarget', 1.1, 1],
  ['Score / Call', 'score'],
] as const

const yardageToOffset = (yardage: number, tickSpacing: number) =>
  ((yardage - LADDER_MIN_YARDAGE) / 10) * tickSpacing

const getYPercentForYardage = (yardage: number, targetYardage: number) =>
  TARGET_LINE_Y_PERCENT + (targetYardage - yardage) * YARDAGE_PERCENT_PER_YARD

const clampYardage = (yardage: number) =>
  Math.min(LADDER_MAX_YARDAGE, Math.max(LADDER_MIN_YARDAGE, yardage))

const variabilityValue = (value: number | undefined, digits = 0, mode: ShotMode = 'stock') => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return ''
  }
  const modeScale = mode === 'pure' ? 0.62 : 1
  return `±${(value * modeScale).toFixed(digits)}`
}

const averageNumbers = (values: Array<number | undefined>) => {
  const definedValues = values.filter((value): value is number => typeof value === 'number')
  if (definedValues.length === 0) {
    return undefined
  }

  return definedValues.reduce((sum, value) => sum + value, 0) / definedValues.length
}

const payloadNumber = (payload: OpenGolfCoachPayload | undefined, keys: string[]) => {
  if (!payload) {
    return undefined
  }

  const parseNumberLike = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
  }

  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null

  const root = asRecord(payload)
  if (!root) {
    return undefined
  }

  const scopedObjects: Record<string, unknown>[] = [root]
  const coach = asRecord(root.open_golf_coach)
  if (coach) {
    scopedObjects.push(coach)
    const usCustomaryUnits = asRecord(coach.us_customary_units)
    if (usCustomaryUnits) {
      scopedObjects.push(usCustomaryUnits)
    }
  }

  for (const source of scopedObjects) {
    for (const key of keys) {
      const parsed = parseNumberLike(source[key])
      if (typeof parsed === 'number') {
        return parsed
      }
    }
  }

  return undefined
}

const carryValue = (shot: Shot) =>
  typeof shot.carryYards === 'number'
    ? shot.carryYards
    : payloadNumber(shot.openGolfCoach, [
        'carry_distance_yards',
        'carryDistanceYards',
        'carry',
      ])

const totalValue = (shot: Shot) =>
  typeof shot.totalYards === 'number'
    ? shot.totalYards
    : payloadNumber(shot.openGolfCoach, [
        'total_distance_yards',
        'totalDistanceYards',
        'total',
      ])

type ReadIdentityProfile = {
  key: string
  club: Club
  clubLabel: string
  variantId: string
  variantLabel: string
  shotCount: number
  carry: number
  total: number
}

type ReadOption = (typeof readOptions)[number]

const applyIdentityToReadOption = (
  option: ReadOption,
  profile: ReadIdentityProfile | undefined,
): ReadOption => {
  if (!profile) {
    return option
  }

  const carry = Math.round(profile.carry)
  const total = Math.round(profile.total)

  return {
    ...option,
    club: profile.clubLabel,
    variant: profile.variantLabel,
    stock: {
      ...option.stock,
      carry,
      total,
      stats: {
        ...option.stock.stats,
        carry: [`${carry} yd`, ''],
        total: [`${total} yd`, ''],
      },
    },
    pure: {
      ...option.pure,
      carry,
      total,
      stats: {
        ...option.pure.stats,
        carry: [`${carry} yd`, ''],
        total: [`${total} yd`, ''],
      },
    },
  }
}

export default function TheReadPage() {
  const [selectedMetric, setSelectedMetric] = useState<SelectedMetric>('carry')
  const [selectedTargetYardage, setSelectedTargetYardage] = useState(100)
  const [selectedIdentityKey, setSelectedIdentityKey] = useState<string | null>(null)
  const [selectedOptionLabel, setSelectedOptionLabel] = useState('Target')
  const [selectedMode, setSelectedMode] = useState<ShotMode>('stock')
  const wheelDeltaRef = useRef(0)
  const savedSessions = useMemo(
    () =>
      loadSavedSessions().filter(
        (session) => isSessionIncludedInAnalysis(session) && isSessionEligibleForAnalysis(session),
      ),
    [],
  )
  const identityProfiles = useMemo(() => {
    const groups = new Map<string, Shot[]>()
    savedSessions.forEach((session) => {
      session.shots.forEach((shot) => {
        if (!shot.included) {
          return
        }
        const variantId = resolveShotVariantId(shot.shotVariantId)
        const key = `${shot.club}:${variantId}`
        groups.set(key, [...(groups.get(key) ?? []), shot])
      })
    })

    return Array.from(groups.entries())
      .map(([key, shots]): ReadIdentityProfile | null => {
        const firstShot = shots[0]
        const carry = averageNumbers(shots.map(carryValue))
        const total = averageNumbers(shots.map(totalValue))
        if (!firstShot || typeof carry !== 'number' || typeof total !== 'number') {
          return null
        }

        const variantId = resolveShotVariantId(firstShot.shotVariantId)
        return {
          key,
          club: firstShot.club,
          clubLabel: getClubLabel(firstShot.club),
          variantId,
          variantLabel: getShotVariantLabel(firstShot.club, variantId),
          shotCount: shots.length,
          carry,
          total,
        }
      })
      .filter((profile): profile is ReadIdentityProfile => Boolean(profile))
      .sort((a, b) => a[selectedMetric] - b[selectedMetric])
  }, [savedSessions, selectedMetric])
  const maxShotMarkersInTenYardGap = Math.max(
    1,
    ...ladderMarks.map(
      (yardage) =>
        identityProfiles.filter((profile) => {
          const yardageValue = profile[selectedMetric]
          return yardageValue >= yardage && yardageValue < yardage + 10
        }).length,
    ),
  )
  const ladderTickSpacing = Math.max(
    BASE_TICK_SPACING,
    maxShotMarkersInTenYardGap * SHOT_MARKER_VERTICAL_SPACE + 20,
  )
  const comparisonOptions = useMemo(() => {
    if (identityProfiles.length === 0) {
      return readOptions
    }

    const targetProfile = identityProfiles.reduce((closest, profile) => {
      const closestDelta = Math.abs(closest[selectedMetric] - selectedTargetYardage)
      const profileDelta = Math.abs(profile[selectedMetric] - selectedTargetYardage)
      return profileDelta < closestDelta ? profile : closest
    }, identityProfiles[0])
    const shortProfiles = identityProfiles
      .filter((profile) => profile[selectedMetric] <= selectedTargetYardage)
      .sort((a, b) => b[selectedMetric] - a[selectedMetric])
    const longProfiles = identityProfiles
      .filter((profile) => profile[selectedMetric] >= selectedTargetYardage)
      .sort((a, b) => a[selectedMetric] - b[selectedMetric])
    const shortProfile =
      shortProfiles[0]?.key === targetProfile.key && shortProfiles[1]
        ? shortProfiles[1]
        : shortProfiles[0]
    const longProfile =
      longProfiles[0]?.key === targetProfile.key && longProfiles[1]
        ? longProfiles[1]
        : longProfiles[0]
    const profilesByLabel: Record<string, ReadIdentityProfile | undefined> = {
      Short: shortProfile ?? targetProfile,
      Target: targetProfile,
      Long: longProfile ?? targetProfile,
    }

    return readOptions.map((option) => applyIdentityToReadOption(option, profilesByLabel[option.label]))
  }, [identityProfiles, selectedMetric, selectedTargetYardage])
  const selectedOption =
    comparisonOptions.find((option) => option.label === selectedOptionLabel) ?? comparisonOptions[1]
  const selectedShot = selectedOption[selectedMode]
  const selectedYardageOffset = yardageToOffset(selectedTargetYardage, ladderTickSpacing)
  const selectYardage = (yardage: number) => setSelectedTargetYardage(clampYardage(yardage))
  const selectIdentity = (profile: ReadIdentityProfile) => {
    setSelectedIdentityKey(profile.key)
    selectYardage(Math.round(profile[selectedMetric]))
  }
  const selectShot = (optionLabel: string, mode: ShotMode = 'stock') => {
    setSelectedOptionLabel(optionLabel)
    setSelectedMode(mode)
  }
  useEffect(() => {
    const selectedProfile = identityProfiles.find((profile) => profile.key === selectedIdentityKey)
    if (!selectedProfile) {
      return
    }
    setSelectedTargetYardage(clampYardage(Math.round(selectedProfile[selectedMetric])))
  }, [identityProfiles, selectedIdentityKey, selectedMetric])
  const scrollLadder = (deltaY: number) => {
    wheelDeltaRef.current += deltaY
    if (Math.abs(wheelDeltaRef.current) < WHEEL_STEP_THRESHOLD) {
      return
    }
    const direction = wheelDeltaRef.current > 0 ? 1 : -1
    wheelDeltaRef.current = 0
    setSelectedTargetYardage((yardage) => clampYardage(yardage + direction * 10))
  }
  const formatDotValue = (option: ReadOption['stock']) =>
    `${selectedMetric === 'carry' ? option.carry : option.total}`
  const metricTop = (option: ReadOption['stock']) =>
    `${getYPercentForYardage(option[selectedMetric], selectedTargetYardage)}%`
  const targetLineTop = `${getYPercentForYardage(
    selectedTargetYardage,
    selectedTargetYardage,
  )}%`

  return (
    <main className="the-read-page">
      <div className="the-read-shell">
        <header className="the-read-header">
          <div className="the-read-header-main">
            <img alt="The Read" className="the-read-logo" src={theReadLogo} />
            <div className="the-read-toggle" aria-label="Distance mode">
              <button
                className={selectedMetric === 'carry' ? 'is-active' : undefined}
                onClick={() => setSelectedMetric('carry')}
                type="button"
              >
                Carry
              </button>
              <button
                className={selectedMetric === 'total' ? 'is-active' : undefined}
                onClick={() => setSelectedMetric('total')}
                type="button"
              >
                Total
              </button>
            </div>
          </div>
          <nav className="the-read-utility-actions" aria-label="The Read navigation">
            <a href="/dashboard">Dashboard</a>
            <a href="/looper">New Session</a>
          </nav>
        </header>

        <section className="the-read-layout" aria-label="The Read workspace">
          <div className="the-read-ladder-card">
            <div
              className="the-read-ladder"
              onWheel={(event) => {
                event.preventDefault()
                scrollLadder(event.deltaY)
              }}
            >
              <div className="the-read-ladder-target" />
              <div
                className="the-read-ladder-tape"
                style={{
                  height: `${(ladderMarks.length - 1) * ladderTickSpacing}px`,
                  transform: `translateY(-${selectedYardageOffset}px)`,
                }}
              >
                {ladderMarks.map((yardage) => (
                  <button
                    className={
                      yardage === selectedTargetYardage
                        ? 'the-read-yardage-tick is-selected'
                        : 'the-read-yardage-tick'
                    }
                    key={yardage}
                    onClick={() => selectYardage(yardage)}
                    style={{ top: `${yardageToOffset(yardage, ladderTickSpacing)}px` }}
                    type="button"
                  >
                    <span>{yardage}</span>
                  </button>
                ))}
                {identityProfiles.map((profile) => (
                  <button
                    className={
                      selectedIdentityKey === profile.key
                        ? 'the-read-shot-marker the-read-shot-marker-safe is-selected'
                        : 'the-read-shot-marker the-read-shot-marker-safe'
                    }
                    key={profile.key}
                    onClick={() => selectIdentity(profile)}
                    style={{
                      top: `${yardageToOffset(profile[selectedMetric], ladderTickSpacing)}px`,
                    }}
                    title={`${profile.clubLabel} ${profile.variantLabel} (${profile.shotCount} shots)`}
                    type="button"
                  >
                    {profile.clubLabel} {profile.variantLabel}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <aside className="the-read-decision-panel" aria-label="Decision panel">
            <div className="the-read-card the-read-looper-card">
              <p>Select a yardage to get the call.</p>
            </div>

            <div className="the-read-dispersion-panel">
              <div className="the-read-target-line" style={{ top: targetLineTop }}>
                <span>{selectedTargetYardage} yd target</span>
              </div>
              {comparisonOptions.map((option) => (
                <article className="the-read-dispersion-column" key={option.label}>
                  <div className="the-read-dispersion-head">
                    <span>{option.label}</span>
                    <strong className="the-read-shot-identity-line">
                      <span>{option.club}</span>
                      <b>{option.variant}</b>
                    </strong>
                    <p>{option.score}</p>
                  </div>
                  <div className="the-read-dispersion-plot">
                    <button
                      className={
                        selectedOptionLabel === option.label && selectedMode === 'stock'
                          ? 'the-read-ellipse the-read-ellipse-stock is-selected'
                          : 'the-read-ellipse the-read-ellipse-stock'
                      }
                      onClick={() => selectShot(option.label, 'stock')}
                      style={{
                        left: option.stock.left,
                        top: metricTop(option.stock),
                        width: option.stock.width,
                        height: option.stock.height,
                        transform: `translate(-50%, -50%) rotate(${option.stock.rotate})`,
                      }}
                      type="button"
                    >
                      <span className="the-read-ellipse-dot">
                        {formatDotValue(option.stock)}
                      </span>
                    </button>
                    <button
                      className={
                        selectedOptionLabel === option.label && selectedMode === 'pure'
                          ? 'the-read-ellipse the-read-ellipse-pure is-selected'
                          : 'the-read-ellipse the-read-ellipse-pure'
                      }
                      onClick={() => selectShot(option.label, 'pure')}
                      style={{
                        left: option.pure.left,
                        top: metricTop(option.pure),
                        width: option.pure.width,
                        height: option.pure.height,
                        transform: `translate(-50%, -50%) rotate(${option.pure.rotate})`,
                      }}
                      type="button"
                    >
                      <span className="the-read-ellipse-dot">
                        {formatDotValue(option.pure)}
                      </span>
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <aside className="the-read-inspector" aria-label="Selected shot details">
              <div className="the-read-inspector-head">
                <span
                  className={
                    selectedMode === 'stock'
                      ? 'the-read-inspector-mode is-stock'
                      : 'the-read-inspector-mode is-pure'
                  }
                >
                  {selectedMode === 'stock' ? 'Stock' : 'Pure'}
                </span>
                <strong className="the-read-inspector-identity">
                  <span>{selectedOption.club}</span>
                  <em>{selectedOption.variant}</em>
                </strong>
              </div>
              <div className="the-read-inspector-rows">
                {inspectorRows.map(([label, key, variability, variabilityDigits]) => {
                  const stat = key === 'score' ? undefined : selectedShot.stats[key]
                  const value = key === 'score' ? selectedOption.score : stat?.[0] ?? '—'
                  const range = variabilityValue(variability, variabilityDigits, selectedMode)
                  return (
                    <div
                      className={
                        key === selectedMetric
                          ? 'the-read-inspector-row is-selected-metric'
                          : 'the-read-inspector-row'
                      }
                      key={key}
                    >
                      <span>{label}</span>
                      <strong>{value}</strong>
                      <em className={`the-read-inspector-range is-${selectedMode}`}>
                        {range}
                      </em>
                    </div>
                  )
                })}
              </div>
            </aside>
          </aside>
        </section>
      </div>
    </main>
  )
}
