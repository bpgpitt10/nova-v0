import type { Club } from '../lib/bagConfig'
import { getClubFamily, getIronBucket } from '../lib/clubTaxonomy'
import {
  getShotVariantLabel,
  resolveShotVariantId,
  STOCK_SHOT_VARIANT_ID,
} from '../lib/shotVariants'
import type { IncomingNovaShot } from '../types'
import type { MockShotContext, NovaAdapter, NovaConnection } from './nova'

export const MOCK_STOCK_CARRY_YARDS: Partial<Record<Club, number>> = {
  Driver: 250,
  'Mini Driver': 230,
  '3W': 220,
  '3H': 205,
  '5i': 190,
  '6i': 175,
  '7i': 160,
  '8i': 145,
  '9i': 130,
  PW: 115,
  GW: 100,
  SW: 90,
  LW: 80,
}

const fallbackStockCarry = (club: Club) => {
  if (club.endsWith('W')) {
    const number = Number.parseInt(club, 10)
    return Number.isFinite(number) ? 235 - number * 5 : 220
  }
  if (club.endsWith('H')) {
    const number = Number.parseInt(club, 10)
    return Number.isFinite(number) ? 220 - number * 5 : 195
  }
  if (club.endsWith('i')) {
    const number = Number.parseInt(club, 10)
    return Number.isFinite(number) ? 265 - number * 15 : 150
  }
  if (club === 'AW') return 105
  return 150
}

const stockCarryForClub = (club: Club) => MOCK_STOCK_CARRY_YARDS[club] ?? fallbackStockCarry(club)

const seededNoise = (seed: number, salt: number) => {
  const value = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

const jitter = (seed: number, salt: number, amount: number) =>
  (seededNoise(seed, salt) * 2 - 1) * amount

const createMockSessionSeed = () =>
  Date.now() + Math.floor(Math.random() * 1_000_000)

const variantCarryFactor = (club: Club, shotVariantId: string | undefined, seed: number) => {
  const resolvedId = resolveShotVariantId(shotVariantId)
  if (resolvedId === STOCK_SHOT_VARIANT_ID) {
    return 1
  }

  const label = getShotVariantLabel(club, resolvedId).toLowerCase()
  if (label.includes('choke')) return 0.9 + seededNoise(seed, 11) * 0.05
  if (label.includes('3/4') || label.includes('three quarter')) return 0.75 + seededNoise(seed, 12) * 0.1
  if (label.includes('1/2') || label.includes('half')) return 0.55 + seededNoise(seed, 13) * 0.1
  if (label.includes('soft') || label.includes('flighted')) return 0.85 + seededNoise(seed, 14) * 0.1
  return 0.6 + seededNoise(seed, 15) * 0.4
}

const rolloutForClub = (club: Club, seed: number) => {
  const family = getClubFamily(club)
  const ironBucket = getIronBucket(club)
  if (club === 'Driver' || club === 'Mini Driver' || family === 'wood' || family === 'hybrid') {
    return 10 + seededNoise(seed, 21) * 15
  }
  if (family === 'wedge') {
    return seededNoise(seed, 22) * 5
  }
  if (ironBucket === 'long') {
    return 5 + seededNoise(seed, 23) * 5
  }
  return 3 + seededNoise(seed, 24) * 5
}

const offlineForClub = (club: Club, seed: number) => {
  const family = getClubFamily(club)
  const ironBucket = getIronBucket(club)
  const width =
    club === 'Driver' || club === 'Mini Driver'
      ? 18
      : family === 'wood'
        ? 16
        : family === 'hybrid' || ironBucket === 'long'
          ? 13
          : family === 'wedge'
            ? 7
            : 10
  return jitter(seed, 31, width)
}

const launchForClub = (club: Club, seed: number) => {
  const family = getClubFamily(club)
  const ironBucket = getIronBucket(club)
  const base =
    club === 'Driver' || club === 'Mini Driver'
      ? 12
      : family === 'wood' || family === 'hybrid'
        ? 14
        : family === 'wedge'
          ? 29
          : ironBucket === 'long'
            ? 17
            : ironBucket === 'mid'
              ? 20
              : 24
  return base + jitter(seed, 41, 2.2)
}

const spinForClub = (club: Club, seed: number) => {
  const family = getClubFamily(club)
  const ironBucket = getIronBucket(club)
  const base =
    club === 'Driver' || club === 'Mini Driver'
      ? 2600
      : family === 'wood'
        ? 3400
        : family === 'hybrid'
          ? 4300
          : family === 'wedge'
            ? 8500
            : ironBucket === 'long'
              ? 4800
              : ironBucket === 'mid'
                ? 6000
                : 7200
  return base + jitter(seed, 42, family === 'wedge' ? 650 : 450)
}

const ballSpeedForCarry = (carryYards: number, club: Club, seed: number) => {
  const family = getClubFamily(club)
  const factor =
    club === 'Driver' || club === 'Mini Driver' || family === 'wood'
      ? 0.62
      : family === 'hybrid'
        ? 0.59
        : family === 'wedge'
          ? 0.78
          : 0.65
  return carryYards * factor + 8 + jitter(seed, 51, 2.5)
}

const descentForClub = (club: Club, seed: number) => {
  const family = getClubFamily(club)
  const base =
    club === 'Driver' || club === 'Mini Driver'
      ? 34
      : family === 'wood' || family === 'hybrid'
        ? 39
        : family === 'wedge'
          ? 49
          : 44
  return base + jitter(seed, 61, 3)
}

export const buildMockNovaShot = (
  shotNumber: number,
  context: MockShotContext = { club: '7i', shotVariantId: STOCK_SHOT_VARIANT_ID },
  sessionSeed = 0,
): IncomingNovaShot => {
  const shotSeed = shotNumber + sessionSeed * 1000
  const stockCarry = stockCarryForClub(context.club)
  const resolvedVariantId = resolveShotVariantId(context.shotVariantId)
  const carryFactor = Math.min(
    1,
    Math.max(0.55, variantCarryFactor(context.club, resolvedVariantId, shotSeed)),
  )
  const rawCarryYards = Number(
    (stockCarry * carryFactor + jitter(shotSeed, 1, stockCarry * 0.025)).toFixed(1),
  )
  const carryYards =
    resolvedVariantId === STOCK_SHOT_VARIANT_ID
      ? rawCarryYards
      : Math.min(stockCarry, rawCarryYards)
  const totalYards = Math.round(carryYards + rolloutForClub(context.club, shotSeed))
  const ballSpeedMph = Number(ballSpeedForCarry(carryYards, context.club, shotSeed).toFixed(1))
  const verticalLaunchAngleDegrees = Number(launchForClub(context.club, shotSeed).toFixed(1))
  const horizontalLaunchAngleDegrees = Number(jitter(shotSeed, 32, 3.5).toFixed(1))
  const totalSpinRpm = Math.max(1800, Math.round(spinForClub(context.club, shotSeed)))
  const spinAxisDegrees = Number(jitter(shotSeed, 33, 14).toFixed(1))
  const offlineYards = Number(offlineForClub(context.club, shotSeed).toFixed(2))
  const descentAngle = Number(descentForClub(context.club, shotSeed).toFixed(1))
  const peakHeight = Math.round(carryYards * (verticalLaunchAngleDegrees / 100) + 36 + jitter(shotSeed, 62, 6))
  const clubSpeed = Number((ballSpeedMph / (getClubFamily(context.club) === 'wedge' ? 1.22 : 1.38)).toFixed(1))
  const smashFactor = Number((ballSpeedMph / clubSpeed).toFixed(2))
  const shotVariantLabel = getShotVariantLabel(context.club, context.shotVariantId)

  return {
    id: `mock-${Date.now()}-${shotNumber}`,
    timestamp: new Date().toISOString(),
    ballSpeedMph,
    ball_speed_meters_per_second: Number((ballSpeedMph * 0.44704).toFixed(2)),
    carryYards,
    totalYards,
    offlineYards,
    launchAngleDeg: verticalLaunchAngleDegrees,
    vertical_launch_angle_degrees: verticalLaunchAngleDegrees,
    horizontal_launch_angle_degrees: horizontalLaunchAngleDegrees,
    spinRpm: totalSpinRpm,
    total_spin_rpm: totalSpinRpm,
    spin_axis_degrees: spinAxisDegrees,
    shotName: `${context.club} ${shotVariantLabel}`,
    shotRanking: seededNoise(shotSeed, 71) > 0.72 ? 'A' : seededNoise(shotSeed, 72) > 0.28 ? 'B' : 'C',
    openGolfCoach: {
      carry_distance_yards: carryYards,
      total_distance_yards: totalYards,
      offline_distance_yards: offlineYards,
      descent_angle_degrees: descentAngle,
      peak_height_yards: peakHeight,
      club_speed_mph: clubSpeed,
      smash_factor: smashFactor,
      shot_name: `${context.club} ${shotVariantLabel}`,
    },
  }
}

export const mockNovaAdapter: NovaAdapter = {
  connectToShots(onShot, onStatusChange, onDebugEvent, getMockShotContext): NovaConnection {
    console.info('[Mock Nova] mock mode active')
    const sessionSeed = createMockSessionSeed()
    let shotNumber = 1
    let timer: number | null = null

    const emitShot = () => {
      const shot = buildMockNovaShot(shotNumber, getMockShotContext?.(), sessionSeed)

      onDebugEvent?.({
        rawMessage: JSON.stringify(shot),
        normalizedShot: shot,
        openGolfCoachInput: null,
        openGolfCoachResponse: null,
      })

      onShot(shot)
      shotNumber += 1
    }

    const startTimer = () => {
      timer = window.setInterval(emitShot, 3500)
    }

    const stopTimer = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }

    startTimer()
    window.queueMicrotask(() => onStatusChange?.('connected'))

    return {
      mode: 'mock',
      pause: () => {
        console.info('[Mock Nova] paused')
        stopTimer()
        onStatusChange?.('paused')
      },
      resume: () => {
        console.info('[Mock Nova] resumed')
        if (timer === null) {
          startTimer()
        }
        onStatusChange?.('connected')
      },
      disconnect: () => {
        console.info('[Mock Nova] disconnected')
        stopTimer()
        onStatusChange?.('disconnected')
      },
    }
  },
}
