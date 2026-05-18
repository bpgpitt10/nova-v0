import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import theReadLogo from '../assets/the-read-logo.png'
import TheReadLadderExportCard from '../components/TheReadLadderExportCard'
import type { ReadLadderExportRow } from '../components/TheReadLadderExportCard'
import { getClubLabel, type Club } from '../lib/bagConfig'
import { confidenceConfig } from '../lib/confidenceConfig'
import {
  isShotIncludedInAnalysis,
  sessionHistoricalWeightForClub,
} from '../lib/historicalModel'
import {
  isSessionEligibleForAnalysis,
  isSessionIncludedInAnalysis,
  loadSavedSessions,
} from '../lib/sessions'
import { getShotVariantLabel, resolveShotVariantId } from '../lib/shotVariants'
import { buildShotProfilesForIdentity } from '../lib/shotProfiles'
import type { Shot } from '../types'
import './TheReadPage.css'

const LADDER_MIN_YARDAGE = 30
const LADDER_MAX_YARDAGE = 320
const BASE_TICK_SPACING = 72
const SHOT_MARKER_VERTICAL_SPACE = 44
const SHOT_MARKER_LANE_THRESHOLD_PX = 46
const SHOT_MARKER_LANE_RIGHT_OFFSETS = [8, 68, 128, 38, 98, 158]
const TARGET_LINE_Y_PERCENT = 50
const YARDAGE_PERCENT_PER_YARD = 1.2
const LADDER_SCROLL_SENSITIVITY = 2.55
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
    variant: 'Full',
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

type ShotStats = (typeof readOptions)[number]['stock']['stats']
type InspectorMetricKey = keyof ShotStats | 'score'
type InspectorRow = readonly [
  label: string,
  key: InspectorMetricKey,
  variability?: number,
  variabilityDigits?: number,
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
] satisfies readonly InspectorRow[]

const yardageToOffset = (yardage: number, tickSpacing: number) =>
  ((yardage - LADDER_MIN_YARDAGE) / 10) * tickSpacing

const getYPercentForYardage = (yardage: number, targetYardage: number) =>
  TARGET_LINE_Y_PERCENT + (targetYardage - yardage) * YARDAGE_PERCENT_PER_YARD

const clampYardage = (yardage: number) =>
  Math.min(LADDER_MAX_YARDAGE, Math.max(LADDER_MIN_YARDAGE, yardage))

const pdfDateSlug = (date: Date) => date.toISOString().slice(0, 10)

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

type ReadIdentityProfile = {
  key: string
  club: Club
  clubLabel: string
  variantId: string
  variantLabel: string
  shotCount: number
  carry: number
  total: number
  pureCarry: number
  pureTotal: number
  carryStdDev?: number
  totalStdDev?: number
  offline?: number
  offlineStdDev?: number
}

type ReadOption = (typeof readOptions)[number]
type DisplayReadOption = ReadOption & {
  profile?: ReadIdentityProfile
}

type ReadCandidate = {
  option: DisplayReadOption
  score: number
  distanceDelta: number
  pureDelta: number
  pureGapPercent: number
  directionTrust: number
  adjustmentHint: 'smooth' | 'stock' | 'none'
}

type ReadReasonCategory =
  | 'distance'
  | 'trust'
  | 'pureGap'
  | 'direction'
  | 'adjustment'
  | 'sampleSize'

type ReadReasonFamily =
  | 'pureLongRisk'
  | 'controlledSwing'
  | 'shortClubForced'
  | 'distanceFit'
  | 'directionWindow'
  | 'trustScore'
  | 'sampleSize'

type ReadReasonTag = {
  category: ReadReasonCategory
  family: ReadReasonFamily
  priority: number
  text: string
}

const caddieCallForReadScore = (score: number, shotCount: number) => {
  if (shotCount < confidenceConfig.insufficientData.minIncludedShots) {
    return 'Insufficient Data'
  }

  return (
    confidenceConfig.caddieCalls.find((call) => score >= call.minScore)?.label ??
    'Liability'
  )
}

const readScoreCallForProfile = (profile: ReadIdentityProfile) => {
  const distanceStdDev = averageNumbers([profile.carryStdDev, profile.totalStdDev])
  const distanceTrust =
    typeof distanceStdDev === 'number' ? Math.max(0, 100 - distanceStdDev * 5) : 65
  const directionTrust =
    typeof profile.offlineStdDev === 'number'
      ? Math.max(0, 100 - profile.offlineStdDev * 5)
      : 65
  const dataTrust = Math.min(100, (profile.shotCount / 12) * 100)
  const carryPureGap = profile.carry > 0 ? Math.max(0, (profile.pureCarry - profile.carry) / profile.carry) : 0
  const totalPureGap = profile.total > 0 ? Math.max(0, (profile.pureTotal - profile.total) / profile.total) : 0
  const pureGap = Math.max(carryPureGap, totalPureGap)
  const pureTrust =
    pureGap < 0.05
      ? 100
      : pureGap <= 0.1
        ? 78
        : 52
  const score = Math.round(
    distanceTrust * 0.25 +
    directionTrust * 0.35 +
    dataTrust * 0.25 +
    pureTrust * 0.15,
  )
  const call = caddieCallForReadScore(score, profile.shotCount)

  return {
    callTag: call === 'Insufficient Data' ? 'Needs Data' : call,
    score,
  }
}

const formatReadScoreCall = ({ callTag, score }: { callTag: string; score: number }) =>
  `${score} (${callTag})`

type ReadIdentityProfileWithOffline = ReadIdentityProfile & {
  offline: number
}

const hasOfflineValue = (profile: ReadIdentityProfile): profile is ReadIdentityProfileWithOffline =>
  typeof profile.offline === 'number'

const buildReadLadderExportRow = (profile: ReadIdentityProfileWithOffline): ReadLadderExportRow => {
  const scoreCall = readScoreCallForProfile(profile)
  return {
    key: profile.key,
    club: profile.club,
    clubLabel: profile.clubLabel,
    variantId: profile.variantId,
    variantLabel: profile.variantLabel,
    carry: profile.carry,
    carryRange: profile.carryStdDev,
    total: profile.total,
    totalRange: profile.totalStdDev,
    offline: profile.offline,
    offlineRange: profile.offlineStdDev,
    score: scoreCall.score,
    callTag: scoreCall.callTag,
  }
}

const applyIdentityToReadOption = (
  option: ReadOption,
  profile: ReadIdentityProfile | undefined,
): DisplayReadOption => {
  if (!profile) {
    return option
  }

  const carry = Math.round(profile.carry)
  const total = Math.round(profile.total)
  const pureCarry = Math.round(profile.pureCarry)
  const pureTotal = Math.round(profile.pureTotal)

  return {
    ...option,
    profile,
    club: profile.clubLabel,
    variant: profile.variantLabel,
    score: formatReadScoreCall(readScoreCallForProfile(profile)),
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
      carry: pureCarry,
      total: pureTotal,
      stats: {
        ...option.pure.stats,
        carry: [`${pureCarry} yd`, ''],
        total: [`${pureTotal} yd`, ''],
      },
    },
  }
}

const scoreReadCandidate = (
  option: DisplayReadOption,
  selectedMetric: SelectedMetric,
  selectedTargetYardage: number,
): ReadCandidate | null => {
  const profile = option.profile
  if (!profile) {
    return null
  }

  const stockValue = profile[selectedMetric]
  const pureValue = selectedMetric === 'carry' ? profile.pureCarry : profile.pureTotal
  const distanceDelta = stockValue - selectedTargetYardage
  const pureDelta = pureValue - selectedTargetYardage
  const shortBy = Math.max(0, -distanceDelta)
  const longBy = Math.max(0, distanceDelta)
  const manageableLong = longBy > 0 && longBy <= 10
  const distanceFit = Math.max(
    0,
    44 - shortBy * 3.1 - (manageableLong ? longBy * 1.25 : longBy * 2.2),
  )
  const longMissRisk =
    longBy <= 3
      ? longBy * 0.9
      : longBy <= 10
        ? 2.7 + (longBy - 3) * 1.15
        : 10.75 + (longBy - 10) * 3.4
  const shortMissRisk =
    shortBy <= 3
      ? shortBy * 0.8
      : shortBy <= 6
        ? 2.4 + (shortBy - 3) * 2.2
        : shortBy <= 10
          ? 9 + (shortBy - 6) * 3.8
          : 24.2 + (shortBy - 10) * 5.4
  const pureLongRisk = Math.max(0, pureDelta - (manageableLong ? 6 : 2)) * 1.25
  const pureGapPercent = stockValue > 0 ? Math.max(0, (pureValue - stockValue) / stockValue) : 0
  const pureGapRisk =
    pureGapPercent < 0.05
      ? 0
      : pureGapPercent <= 0.1
        ? (pureGapPercent - 0.05) * 190
        : 9.5 + (pureGapPercent - 0.1) * 280
  const confidenceTrust = Math.min(18, profile.shotCount * 3)
  const directionTrust =
    typeof profile.offlineStdDev === 'number'
      ? Math.max(0, 20 - profile.offlineStdDev * 1.55)
      : 8
  const dataConfidence = profile.shotCount >= 5 ? 0 : (5 - profile.shotCount) * 4
  const adjustmentHint = manageableLong ? 'smooth' : pureGapPercent > 0.08 ? 'stock' : 'none'
  const score =
    distanceFit +
    confidenceTrust +
    directionTrust -
    longMissRisk -
    shortMissRisk -
    pureLongRisk -
    pureGapRisk -
    dataConfidence

  return {
    option,
    score,
    distanceDelta,
    pureDelta,
    pureGapPercent,
    directionTrust,
    adjustmentHint,
  }
}

const buildLooperRead = (
  call: ReadCandidate | null,
  hasProfiles: boolean,
  selectedTargetYardage: number,
) => {
  if (!hasProfiles || !call) {
    return {
      primary: 'Not enough shot history yet.',
      lines: ['Add more shots and I’ll make the read.'],
    }
  }

  const reasonTags: ReadReasonTag[] = []
  const distance = Math.round(Math.abs(call.distanceDelta))

  const shortBy = Math.max(0, -call.distanceDelta)
  const longBy = Math.max(0, call.distanceDelta)

  if (distance <= 3) {
    reasonTags.push({
      category: 'distance',
      family: 'distanceFit',
      priority: 60,
      text: 'This one fits the number without needing extra.',
    })
  } else if (shortBy > 0 && shortBy <= 3) {
    reasonTags.push({
      category: 'distance',
      family: 'distanceFit',
      priority: 72,
      text: 'It’s barely short, and the front miss stays manageable.',
    })
  } else if (shortBy <= 6 && shortBy > 3) {
    reasonTags.push({
      category: 'distance',
      family: 'distanceFit',
      priority: 76,
      text: 'It’s a little short, but the front miss is still playable.',
    })
  } else if (shortBy > 6) {
    reasonTags.push({
      category: 'distance',
      family: 'shortClubForced',
      priority: 94,
      text: 'The shorter club leaves too much number.',
    })
  } else if (call.adjustmentHint === 'smooth') {
    reasonTags.push({
      category: 'adjustment',
      family: 'controlledSwing',
      priority: 76,
      text:
        longBy <= 10
          ? 'This is a touch long, but easier to take something off than force the shorter club.'
          : 'Think controlled swing here, not full.',
    })
  }

  if (call.pureGapPercent > 0.1 || call.pureDelta > 6) {
    reasonTags.push({
      category: 'pureGap',
      family: 'pureLongRisk',
      priority: 100,
      text: 'Pure jumps long here, so don’t chase the flushed one.',
    })
  } else if (call.adjustmentHint === 'stock') {
    reasonTags.push({
      category: 'adjustment',
      family: 'pureLongRisk',
      priority: 64,
      text: 'Make a stock swing and keep the flushed one out of the plan.',
    })
  }

  if (call.directionTrust >= 13) {
    reasonTags.push({
      category: 'direction',
      family: 'directionWindow',
      priority: distance > 3 ? 88 : 74,
      text:
        distance > 3
          ? 'You’re giving up a couple yards, but the direction window is cleaner.'
          : 'The stock window is tighter than the longer option.',
    })
  } else if (distance > 3) {
    reasonTags.push({
      category: 'trust',
      family: shortBy > 0 ? 'shortClubForced' : 'controlledSwing',
      priority: 82,
      text:
        shortBy > 0
          ? 'The front miss comes into play with the shorter option.'
          : 'Better to take a little off this than force the shorter club.',
    })
  }

  if (call.option.profile && call.option.profile.shotCount < 5) {
    reasonTags.push({
      category: 'sampleSize',
      family: 'sampleSize',
      priority: 40,
      text: 'The sample is still light, so treat the read as a lean.',
    })
  }

  const selectedCategories = new Set<ReadReasonCategory>()
  const selectedFamilies = new Set<ReadReasonFamily>()
  const lines = reasonTags
    .sort((left, right) => right.priority - left.priority)
    .filter((tag) => {
      if (selectedCategories.has(tag.category) || selectedFamilies.has(tag.family)) {
        return false
      }
      selectedCategories.add(tag.category)
      selectedFamilies.add(tag.family)
      return true
    })
    .slice(0, 2)
    .map((tag) => tag.text)

  return {
    primary: `${selectedTargetYardage} yd Target: ${call.option.club} ${call.option.variant}`,
    lines,
  }
}

export default function TheReadPage() {
  const [selectedMetric, setSelectedMetric] = useState<SelectedMetric>('carry')
  const [selectedTargetYardage, setSelectedTargetYardage] = useState(100)
  const [selectedIdentityKey, setSelectedIdentityKey] = useState<string | null>(null)
  const [selectedOptionLabel, setSelectedOptionLabel] = useState('Target')
  const [selectedMode, setSelectedMode] = useState<ShotMode>('stock')
  const [isExportingPdf, setIsExportingPdf] = useState(false)
  const [exportGeneratedAt, setExportGeneratedAt] = useState(() => new Date())
  const dragStateRef = useRef<{ pointerId: number; startY: number; startYardage: number } | null>(null)
  const ladderRef = useRef<HTMLDivElement | null>(null)
  const exportCardRef = useRef<HTMLDivElement | null>(null)
  const savedSessions = useMemo(
    () =>
      loadSavedSessions().filter(
        (session) => isSessionIncludedInAnalysis(session) && isSessionEligibleForAnalysis(session),
      ),
    [],
  )
  const identityProfiles = useMemo(() => {
    const groups = new Map<
      string,
      {
        club: Club
        variantId: string
        shots: Shot[]
        shotWeightsById: Map<string, number>
      }
    >()
    savedSessions.forEach((session) => {
      const sessionGroups = new Map<string, Shot[]>()
      session.shots.forEach((shot) => {
        if (!isShotIncludedInAnalysis(shot)) {
          return
        }
        const variantId = resolveShotVariantId(shot.shotVariantId)
        const key = `${shot.club}:${variantId}`
        sessionGroups.set(key, [...(sessionGroups.get(key) ?? []), shot])
      })

      sessionGroups.forEach((shots, key) => {
        const firstShot = shots[0]
        if (!firstShot) {
          return
        }
        const variantId = resolveShotVariantId(firstShot.shotVariantId)
        const group =
          groups.get(key) ??
          {
            club: firstShot.club,
            variantId,
            shots: [],
            shotWeightsById: new Map<string, number>(),
          }
        const sessionWeight = sessionHistoricalWeightForClub(session, firstShot.club)
        const shotWeight = shots.length > 0 ? sessionWeight / shots.length : 0
        shots.forEach((shot) => {
          group.shots.push(shot)
          if (!group.shotWeightsById.has(shot.id)) {
            group.shotWeightsById.set(shot.id, shotWeight)
          }
        })
        groups.set(key, group)
      })
    })

    return Array.from(groups.entries())
      .map(([key, group]): ReadIdentityProfile | null => {
        const { shots, club, variantId, shotWeightsById } = group
        const profiles = buildShotProfilesForIdentity({
          shots,
          club,
          shotWeightsById,
        })
        const stock = profiles.mostLikely
        const pure = profiles.bestAvailable
        const carry = stock?.carry
        const total = stock?.total
        const pureCarry = pure?.carry ?? carry
        const pureTotal = pure?.total ?? total
        if (
          typeof carry !== 'number' ||
          typeof total !== 'number' ||
          typeof pureCarry !== 'number' ||
          typeof pureTotal !== 'number'
        ) {
          return null
        }

        return {
          key,
          club,
          clubLabel: getClubLabel(club),
          variantId,
          variantLabel: getShotVariantLabel(club, variantId),
          shotCount: shots.length,
          carry,
          total,
          pureCarry,
          pureTotal,
          carryStdDev: stock?.carryVariability,
          totalStdDev: stock?.totalVariability,
          offline: stock?.offlineMean,
          offlineStdDev: stock?.dispersionVariability,
        }
      })
      .filter((profile): profile is ReadIdentityProfile => Boolean(profile))
      .sort((a, b) => a[selectedMetric] - b[selectedMetric])
  }, [savedSessions, selectedMetric])
  const readLadderExportRows = useMemo(
    () =>
      identityProfiles
        .filter(hasOfflineValue)
        .map(buildReadLadderExportRow)
        .sort((a, b) => a.carry - b.carry),
    [identityProfiles],
  )
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
  const ladderIdentityMarkers = useMemo(() => {
    const clusters: ReadIdentityProfile[][] = []
    identityProfiles.forEach((profile) => {
      const profileOffset = yardageToOffset(profile[selectedMetric], ladderTickSpacing)
      const currentCluster = clusters[clusters.length - 1]
      const lastProfile = currentCluster?.[currentCluster.length - 1]
      const lastOffset = lastProfile
        ? yardageToOffset(lastProfile[selectedMetric], ladderTickSpacing)
        : undefined

      if (
        currentCluster &&
        typeof lastOffset === 'number' &&
        Math.abs(profileOffset - lastOffset) <= SHOT_MARKER_LANE_THRESHOLD_PX
      ) {
        currentCluster.push(profile)
        return
      }

      clusters.push([profile])
    })

    return clusters.flatMap((cluster) =>
      cluster.map((profile, index) => ({
        laneIndex: index,
        profile,
        rightOffset:
          SHOT_MARKER_LANE_RIGHT_OFFSETS[index % SHOT_MARKER_LANE_RIGHT_OFFSETS.length],
      })),
    )
  }, [identityProfiles, ladderTickSpacing, selectedMetric])
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
  const readCandidates = comparisonOptions
    .map((option) => scoreReadCandidate(option, selectedMetric, selectedTargetYardage))
    .filter((candidate): candidate is ReadCandidate => Boolean(candidate))
  const readCall =
    readCandidates.length > 0
      ? readCandidates.reduce((best, candidate) =>
          candidate.score > best.score ? candidate : best,
        )
      : null
  const looperRead = buildLooperRead(readCall, identityProfiles.length > 0, selectedTargetYardage)
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
  const yardagePerPixel = (10 / ladderTickSpacing) * LADDER_SCROLL_SENSITIVITY
  const scrollLadder = (deltaY: number) =>
    setSelectedTargetYardage((yardage) =>
      clampYardage(Math.round(yardage + deltaY * yardagePerPixel)),
    )
  useEffect(() => {
    const ladderElement = ladderRef.current
    if (!ladderElement) {
      return
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      scrollLadder(event.deltaY)
    }

    ladderElement.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      ladderElement.removeEventListener('wheel', handleWheel)
    }
  }, [yardagePerPixel])
  const startLadderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startYardage: selectedTargetYardage,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const dragLadder = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }
    const draggedYards = (event.clientY - dragState.startY) * yardagePerPixel
    setSelectedTargetYardage(clampYardage(Math.round(dragState.startYardage + draggedYards)))
  }
  const endLadderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null
    }
  }
  const formatDotValue = (option: ReadOption['stock']) =>
    `${selectedMetric === 'carry' ? option.carry : option.total}`
  const metricTop = (option: ReadOption['stock']) =>
    `${getYPercentForYardage(option[selectedMetric], selectedTargetYardage)}%`
  const targetLineTop = `${getYPercentForYardage(
    selectedTargetYardage,
    selectedTargetYardage,
  )}%`
  const exportReadLadderPdf = async () => {
    const exportElement = exportCardRef.current
    if (!exportElement || isExportingPdf) {
      return
    }

    const generatedAt = new Date()
    setExportGeneratedAt(generatedAt)
    setIsExportingPdf(true)

    try {
      await document.fonts.ready
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      const canvas = await html2canvas(exportElement, {
        backgroundColor: null,
        scale: Math.max(2, Math.min(4, window.devicePixelRatio * 2)),
        useCORS: true,
      })
      const imageData = canvas.toDataURL('image/png')
      const pdf = new jsPDF({
        compress: true,
        format: [canvas.width, canvas.height],
        orientation: 'portrait',
        unit: 'px',
      })
      pdf.addImage(imageData, 'PNG', 0, 0, canvas.width, canvas.height)
      pdf.save(`the-read-ladder-card-${pdfDateSlug(generatedAt)}.pdf`)
    } catch (error) {
      console.error('Failed to export The Read ladder PDF', error)
    } finally {
      setIsExportingPdf(false)
    }
  }

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
            <button
              className="the-read-utility-pdf"
              disabled={isExportingPdf}
              onClick={exportReadLadderPdf}
              type="button"
            >
              {isExportingPdf ? 'Saving...' : 'PDF'}
            </button>
          </nav>
        </header>

        <section className="the-read-layout" aria-label="The Read workspace">
          <div className="the-read-ladder-card">
            <div
              className="the-read-ladder"
              onPointerCancel={endLadderDrag}
              onPointerDown={startLadderDrag}
              onPointerMove={dragLadder}
              onPointerUp={endLadderDrag}
              ref={ladderRef}
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
                    onPointerDown={(event) => event.stopPropagation()}
                    style={{ top: `${yardageToOffset(yardage, ladderTickSpacing)}px` }}
                    type="button"
                  >
                    <span>{yardage}</span>
                  </button>
                ))}
                {ladderIdentityMarkers.map(({ laneIndex, profile, rightOffset }) => (
                  <button
                    className={
                      selectedIdentityKey === profile.key
                        ? 'the-read-shot-marker the-read-shot-marker-safe is-selected'
                        : 'the-read-shot-marker the-read-shot-marker-safe'
                    }
                    key={profile.key}
                    onClick={() => selectIdentity(profile)}
                    onPointerDown={(event) => event.stopPropagation()}
                    style={{
                      right: `${rightOffset}px`,
                      top: `${yardageToOffset(profile[selectedMetric], ladderTickSpacing)}px`,
                      zIndex: selectedIdentityKey === profile.key ? 9 : 4 + Math.min(laneIndex, 2),
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
              <strong>{looperRead.primary}</strong>
              <p>{looperRead.lines.join(' ')}</p>
            </div>

            <div className="the-read-dispersion-panel">
              <div className="the-read-target-line" style={{ top: targetLineTop }}>
                <span>{selectedTargetYardage} yd target</span>
              </div>
              {comparisonOptions.map((option) => (
                <article
                  className={
                    readCall?.option.label === option.label
                      ? 'the-read-dispersion-column is-the-call'
                      : 'the-read-dispersion-column'
                  }
                  key={option.label}
                >
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

        <div className="the-read-export-capture" ref={exportCardRef} aria-hidden="true">
          <TheReadLadderExportCard
            generatedAt={exportGeneratedAt}
            rows={readLadderExportRows}
          />
        </div>
      </div>
    </main>
  )
}
