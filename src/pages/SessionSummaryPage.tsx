import { useMemo } from 'react'
import {
  activeBagClubIds,
  getClubLabel,
  type Club,
} from '../lib/bagConfig'
import { summarizeReviewClub } from '../lib/scoring'
import { loadSavedSessions } from '../lib/sessions'
import type { ReviewClubSummary, SavedSession, Shot } from '../types'
import './SessionSummaryPage.css'
import golfScene from '../assets/Backgrounds/golfscene2.png'
import looperMan from '../assets/looperman.png'
import looperLogoWhite from '../assets/LooperLogoWhite.png'

type FindingConfidence = 'high' | 'medium' | 'low'
type FindingScope = 'session' | 'club'

type RankedFinding = {
  key: string
  line: string
  score: number
  confidence: FindingConfidence
  scope: FindingScope
  passed: boolean
  evidence: string
  category: 'strength' | 'strain' | 'shift' | 'comparison'
}

type SummaryDebug = {
  totalShots: number
  includedClubs: Club[]
  shotCountsByClub: Array<{ club: Club; count: number }>
  componentScoresFound: boolean
  comparisonAvailable: boolean
  headlineKey: string
  headlineEvidence: string
  bulletKeys: string[]
  thresholds: {
    lateDirectionYards: number
    lateCarrySpreadYards: number
    clubShotMinimum: number
  }
  rankedFindings: RankedFinding[]
  componentSnapshots: Array<{
    club: Club
    caddieScore: number
    components: ReviewClubSummary['componentScores']
  }>
}

type SessionSummaryOutput = {
  eyebrow: string
  headline: string
  bullets: string[]
  debug: SummaryDebug
}

const average = (values: Array<number | undefined>) => {
  const defined = values.filter((value): value is number => typeof value === 'number')
  if (defined.length === 0) {
    return undefined
  }
  return defined.reduce((sum, value) => sum + value, 0) / defined.length
}

const standardDeviation = (values: Array<number | undefined>) => {
  const defined = values.filter((value): value is number => typeof value === 'number')
  if (defined.length === 0) {
    return undefined
  }

  const mean = defined.reduce((sum, value) => sum + value, 0) / defined.length
  const variance = defined.reduce((sum, value) => sum + (value - mean) ** 2, 0) / defined.length
  return Math.sqrt(variance)
}

const payloadNumber = (shot: Shot, keys: string[]) => {
  const payload = shot.openGolfCoach
  if (!payload) {
    return undefined
  }

  for (const key of keys) {
    const raw = payload[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }

  return undefined
}

const carryValue = (shot: Shot) =>
  typeof shot.carryYards === 'number'
    ? shot.carryYards
    : payloadNumber(shot, ['carry_distance_yards', 'carryDistanceYards', 'carry'])

const offlineValue = (shot: Shot) =>
  typeof shot.offlineYards === 'number'
    ? shot.offlineYards
    : payloadNumber(shot, ['offline_distance_yards', 'offlineDistanceYards', 'offline'])

const componentLabel = (component: keyof ReviewClubSummary['componentScores']) => {
  switch (component) {
    case 'directionWindow':
      return 'Direction Control'
    case 'distanceWindow':
      return 'Carry Expectation'
    case 'flightQuality':
      return 'Shot Behavior'
    case 'patternStability':
      return 'Pattern Trend'
    case 'dataConfidence':
      return 'Data Confidence'
  }
}

const sessionComparisonLine = (deltaVsHistory: number) => {
  if (deltaVsHistory >= 9) {
    return 'You were really striping it today. Great overall session.'
  }
  if (deltaVsHistory >= 6) {
    return 'Heck of a good session, better than normal.'
  }
  if (deltaVsHistory > 0) {
    return 'Solid day out there, a touch better than your normal.'
  }
  if (deltaVsHistory <= -9) {
    return 'Tougher day than your normal level. It needed more management.'
  }
  if (deltaVsHistory <= -6) {
    return 'A bit below your normal standard today.'
  }
  return 'Slightly off your usual mark today.'
}

const capitalizeBulletStart = (line: string) => {
  const index = line.search(/[a-zA-Z]/)
  if (index === -1) {
    return line
  }
  return `${line.slice(0, index)}${line[index].toUpperCase()}${line.slice(index + 1)}`
}

const capitalizeSentence = (text: string) => {
  if (!text) {
    return text
  }
  const trimmed = text.trimStart()
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

const toConfidence = (score: number): FindingConfidence => {
  if (score >= 88) {
    return 'high'
  }
  if (score >= 70) {
    return 'medium'
  }
  return 'low'
}

const clubSummariesForSession = (
  session: SavedSession,
  priorSessions: SavedSession[],
  clubs: Club[],
) =>
  clubs
    .map((club) => summarizeReviewClub(club, session.shots, priorSessions, session.id))
    .filter((summary): summary is ReviewClubSummary => summary !== null)

const buildSessionSummary = (
  latestSession: SavedSession | null,
  priorSessions: SavedSession[],
): SessionSummaryOutput => {
  const emptyDebug: SummaryDebug = {
    totalShots: 0,
    includedClubs: [],
    shotCountsByClub: [],
    componentScoresFound: false,
    comparisonAvailable: false,
    headlineKey: 'no-session',
    headlineEvidence: 'no ended session available',
    bulletKeys: [],
    thresholds: {
      lateDirectionYards: 2,
      lateCarrySpreadYards: 1.8,
      clubShotMinimum: 4,
    },
    rankedFindings: [],
    componentSnapshots: [],
  }

  if (!latestSession) {
    return {
      eyebrow: 'Every Club Holds a Truth',
      headline: 'No finished session found to summarize.',
      bullets: ['Complete a session to get a proper read.'],
      debug: emptyDebug,
    }
  }

  const thresholds = {
    lateDirectionYards: 2,
    lateCarrySpreadYards: 1.8,
    clubShotMinimum: 4,
  }

  const includedShots = latestSession.shots
  const totalShots = includedShots.length

  const clubCounts = new Map<Club, number>()
  includedShots.forEach((shot) => {
    clubCounts.set(shot.club, (clubCounts.get(shot.club) ?? 0) + 1)
  })

  const includedClubs = activeBagClubIds.filter((club) => (clubCounts.get(club) ?? 0) > 0)
  const shotCountsByClub = includedClubs.map((club) => ({
    club,
    count: clubCounts.get(club) ?? 0,
  }))

  const clubSummaries = clubSummariesForSession(latestSession, priorSessions, includedClubs)
  const componentScoresFound = clubSummaries.length > 0

  const componentSnapshots = clubSummaries.map((summary) => ({
    club: summary.club,
    caddieScore: summary.caddieScore,
    components: summary.componentScores,
  }))

  const shotsInOrder = [...includedShots].sort(
    (left, right) => new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime(),
  )
  const midpoint = Math.max(1, Math.floor(shotsInOrder.length / 2))
  const earlyShots = shotsInOrder.slice(0, midpoint)
  const lateShots = shotsInOrder.slice(midpoint)

  const earlyDirection = average(
    earlyShots.map((shot) => {
      const value = offlineValue(shot)
      return typeof value === 'number' ? Math.abs(value) : undefined
    }),
  )
  const lateDirection = average(
    lateShots.map((shot) => {
      const value = offlineValue(shot)
      return typeof value === 'number' ? Math.abs(value) : undefined
    }),
  )
  const directionDelta =
    typeof earlyDirection === 'number' && typeof lateDirection === 'number'
      ? lateDirection - earlyDirection
      : undefined

  const earlyCarrySpread = standardDeviation(earlyShots.map(carryValue))
  const lateCarrySpread = standardDeviation(lateShots.map(carryValue))
  const carrySpreadDelta =
    typeof earlyCarrySpread === 'number' && typeof lateCarrySpread === 'number'
      ? lateCarrySpread - earlyCarrySpread
      : undefined

  const rankedClubs = [...clubSummaries].sort((left, right) => right.caddieScore - left.caddieScore)
  const bestClub = rankedClubs[0]
  const weakestClub = rankedClubs[rankedClubs.length - 1]

  const sessionAverageScore = average(clubSummaries.map((summary) => summary.caddieScore))
  const historicalClubScores = includedClubs
    .map((club) => {
      const priorClubSummaries = priorSessions
        .map((session) =>
          summarizeReviewClub(
            club,
            session.shots,
            priorSessions.filter((item) => item.id !== session.id),
            session.id,
          ),
        )
        .filter((summary): summary is ReviewClubSummary => summary !== null)
      return average(priorClubSummaries.map((summary) => summary.caddieScore))
    })
    .filter((value): value is number => typeof value === 'number')
  const historicalAverageScore = average(historicalClubScores)
  const comparisonAvailable =
    typeof sessionAverageScore === 'number' && typeof historicalAverageScore === 'number'
  const scoreDeltaVsHistory =
    comparisonAvailable && typeof sessionAverageScore === 'number' && typeof historicalAverageScore === 'number'
      ? sessionAverageScore - historicalAverageScore
      : undefined

  const componentAverages = componentScoresFound
    ? {
        directionWindow: average(clubSummaries.map((summary) => summary.componentScores.directionWindow)),
        distanceWindow: average(clubSummaries.map((summary) => summary.componentScores.distanceWindow)),
        flightQuality: average(
          clubSummaries.map((summary) =>
            typeof summary.componentScores.flightQuality === 'number'
              ? summary.componentScores.flightQuality
              : undefined,
          ),
        ),
        patternStability: average(
          clubSummaries.map((summary) =>
            typeof summary.componentScores.patternStability === 'number'
              ? summary.componentScores.patternStability
              : undefined,
          ),
        ),
      }
    : null

  const findings: RankedFinding[] = []

  if (comparisonAvailable && typeof scoreDeltaVsHistory === 'number' && Math.abs(scoreDeltaVsHistory) >= 4.5) {
    const score = 92 + Math.min(6, Math.abs(scoreDeltaVsHistory))
    findings.push({
      key: 'session-vs-history',
      line: sessionComparisonLine(scoreDeltaVsHistory),
      score,
      confidence: toConfidence(score),
      scope: 'session',
      passed: true,
      evidence: `sessionAvg=${sessionAverageScore?.toFixed(1)} historyAvg=${historicalAverageScore?.toFixed(1)} delta=${scoreDeltaVsHistory.toFixed(1)}`,
      category: 'comparison',
    })
  }

  if (typeof directionDelta === 'number') {
    const magnitude = Math.abs(directionDelta)
    const passed = magnitude >= thresholds.lateDirectionYards
    const score = passed ? 88 + Math.min(8, magnitude * 1.2) : 58
    findings.push({
      key: 'late-direction-shift',
      line:
        directionDelta > 0
          ? 'Direction got looser late.'
          : 'Direction tightened up late.',
      score,
      confidence: toConfidence(score),
      scope: 'session',
      passed,
      evidence: `earlyAbsOffline=${earlyDirection?.toFixed(1)} lateAbsOffline=${lateDirection?.toFixed(1)} delta=${directionDelta.toFixed(1)} threshold=${thresholds.lateDirectionYards}`,
      category: 'shift',
    })
  }

  if (typeof carrySpreadDelta === 'number') {
    const magnitude = Math.abs(carrySpreadDelta)
    const passed = magnitude >= thresholds.lateCarrySpreadYards
    const score = passed ? 80 + Math.min(8, magnitude * 1.4) : 56
    findings.push({
      key: 'late-carry-consistency-shift',
      line:
        carrySpreadDelta > 0
          ? 'Carry control got looser late.'
          : 'Carry control settled late.',
      score,
      confidence: toConfidence(score),
      scope: 'session',
      passed,
      evidence: `earlyCarrySpread=${earlyCarrySpread?.toFixed(1)} lateCarrySpread=${lateCarrySpread?.toFixed(1)} delta=${carrySpreadDelta.toFixed(1)} threshold=${thresholds.lateCarrySpreadYards}`,
      category: 'shift',
    })
  }

  if (componentAverages) {
    const entries = Object.entries(componentAverages)
      .filter(([, value]) => typeof value === 'number')
      .map(([component, value]) => ({
        component: component as keyof typeof componentAverages,
        value: value as number,
      }))
      .sort((left, right) => right.value - left.value)

    if (entries.length > 0) {
      const strongest = entries[0]
      const weakest = entries[entries.length - 1]

      findings.push({
        key: 'strongest-component-session',
        line: `${componentLabel(strongest.component)} held up best.`,
        score: 90,
        confidence: 'high',
        scope: 'session',
        passed: true,
        evidence: `strongest=${strongest.component}:${strongest.value.toFixed(1)}`,
        category: 'strength',
      })

      findings.push({
        key: 'weakest-component-session',
        line:
          weakest.component === 'distanceWindow'
            ? 'Carry control never really settled.'
            : weakest.component === 'directionWindow'
              ? 'Start line was the biggest strain.'
              : weakest.component === 'patternStability'
                ? 'Shot shape was the shakiest piece.'
                : 'Flight window was the biggest strain.',
        score: 89,
        confidence: 'high',
        scope: 'session',
        passed: true,
        evidence: `weakest=${weakest.component}:${weakest.value.toFixed(1)}`,
        category: 'strain',
      })
    }
  }

  const bestClubShots = bestClub ? clubCounts.get(bestClub.club) ?? 0 : 0
  const weakestClubShots = weakestClub ? clubCounts.get(weakestClub.club) ?? 0 : 0
  if (bestClub && bestClubShots >= thresholds.clubShotMinimum) {
    const score = 74 + Math.min(8, bestClubShots)
    findings.push({
      key: 'best-club-call',
      line: `${getClubLabel(bestClub.club)} was your steadiest club.`,
      score,
      confidence: toConfidence(score),
      scope: 'club',
      passed: true,
      evidence: `club=${bestClub.club} score=${bestClub.caddieScore} shots=${bestClubShots}`,
      category: 'strength',
    })
  }

  if (weakestClub && weakestClubShots >= thresholds.clubShotMinimum && weakestClub.club !== bestClub?.club) {
    const score = 72 + Math.min(8, weakestClubShots)
    findings.push({
      key: 'weakest-club-call',
      line: `${getClubLabel(weakestClub.club)} needed the most management.`,
      score,
      confidence: toConfidence(score),
      scope: 'club',
      passed: true,
      evidence: `club=${weakestClub.club} score=${weakestClub.caddieScore} shots=${weakestClubShots}`,
      category: 'strain',
    })
  }

  if (findings.length === 0 || findings.every((finding) => !finding.passed)) {
    findings.push({
      key: 'light-signal',
      line:
        totalShots < 6
          ? 'Not enough in this session for a strong call.'
          : 'A few patterns showed up, but certainty stayed moderate.',
      score: totalShots < 6 ? 96 : 66,
      confidence: totalShots < 6 ? 'high' : 'medium',
      scope: 'session',
      passed: true,
      evidence: `totalShots=${totalShots}`,
      category: 'comparison',
    })
  }

  const rankedFindings = [...findings].sort((left, right) => right.score - left.score)
  const passedRankedFindings = rankedFindings.filter((finding) => finding.passed)

  const headlineFinding =
    passedRankedFindings[0] ?? rankedFindings[0] ?? {
      key: 'fallback',
      line: 'Not enough in this session for a strong call.',
      score: 50,
      confidence: 'low' as const,
      scope: 'session' as const,
      passed: true,
      evidence: 'fallback',
      category: 'comparison' as const,
    }

  const bulletFindings = passedRankedFindings
    .filter((finding) => finding.key !== headlineFinding.key)
    .slice(0, 3)

  const bullets = bulletFindings.map((finding) => capitalizeBulletStart(finding.line))

  return {
    eyebrow: 'Every Club Holds a Truth',
    headline: headlineFinding.line,
    bullets,
    debug: {
      totalShots,
      includedClubs,
      shotCountsByClub,
      componentScoresFound,
      comparisonAvailable,
      headlineKey: headlineFinding.key,
      headlineEvidence: headlineFinding.evidence,
      bulletKeys: bulletFindings.map((finding) => finding.key),
      thresholds,
      rankedFindings,
      componentSnapshots,
    },
  }
}

function SessionSummaryPage() {
  const savedSessions = useMemo(
    () =>
      loadSavedSessions().sort(
        (left, right) =>
          new Date(right.endedAt).getTime() - new Date(left.endedAt).getTime(),
      ),
    [],
  )
  const latestSession = savedSessions[0] ?? null
  const priorSessions = savedSessions.slice(1)

  const summary = useMemo(
    () => buildSessionSummary(latestSession, priorSessions),
    [latestSession, priorSessions],
  )

  return (
    <main className="session-summary-page" style={{ backgroundImage: `url(${golfScene})` }}>
      <div className="session-summary-overlay" />

      <div className="session-summary-shell">
        <header className="session-summary-top">
          <img alt="The Looper" className="session-summary-logo" src={looperLogoWhite} />
        </header>

        <section className="session-summary-content" aria-label="Looper summary">
          <p className="session-summary-label">{capitalizeSentence(summary.eyebrow)}</p>
          <h1 className="session-summary-title">{capitalizeSentence(summary.headline)}</h1>
          {summary.bullets.length > 0 && (
            <ul className="session-summary-bullets">
              {summary.bullets.map((bullet) => (
                <li key={bullet}>{capitalizeSentence(bullet)}</li>
              ))}
            </ul>
          )}
          <a className="session-summary-button" href="/dashboard">
            Continue to Dashboard
          </a>
        </section>

      </div>

      <img alt="" aria-hidden="true" className="session-summary-looperman" src={looperMan} />
    </main>
  )
}

export default SessionSummaryPage
