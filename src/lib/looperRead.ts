/**
 * The Looper's Read on Club Detail: three lines built from the club's own numbers.
 *
 *   1. Verdict: the call, plus what the club does best and what holds it back.
 *   2. Evidence: the carry window in yards, any factor that moved a lot against the
 *      player's usual, and the mishit rate when it is high.
 *   3. On the course: when to pick the club, where to aim, and what to avoid.
 *
 * Wording scales with the size of the number ("well below your usual" for a big
 * drop, "a little below" for a small one) so the read never undersells a problem.
 */

export type ReadCall = 'Attack' | 'Play' | 'Manage' | 'Careful' | 'Liability' | 'Insufficient Data'

export type ReadFactorKey = 'distanceWindow' | 'directionWindow' | 'flightQuality' | 'patternStability'

export type ReadFactor = Readonly<{
  key: ReadFactorKey
  /** 0–100 component score. */
  value?: number
  /** Score now minus this club's usual. */
  delta?: number
}>

export type LooperReadInput = Readonly<{
  clubLabel: string
  call: ReadCall
  factors: readonly ReadFactor[]
  /** Stock carry in yards. */
  stockCarry?: number
  /** Middle 80% of carries (landing window). */
  carryLow?: number
  carryHigh?: number
  /** Stock mean offline in yards; positive is right. */
  missOffline?: number
  /** Swings behind the numbers. */
  swings?: number
  /** Share of classified swings that were mishits (any severity) and severe ones. */
  mishitRate?: number
  severeRate?: number
}>

export type LooperRead = { primary: string; explanation: string; implication: string }

/** Mean offline that earns an aim adjustment, and the swings needed before we suggest one. */
export const AIM_OFFSET_MIN_YARDS = 3
export const AIM_OFFSET_MIN_SWINGS = 8
const STRONG = 70
const WEAK = 55
const MISHIT_MENTION_RATE = 0.12
const SEVERE_MENTION_RATE = 0.08

const VERDICT: Record<ReadCall, string> = {
  Attack: 'is a green light',
  Play: 'is playable',
  Manage: 'is playable but needs managing',
  Careful: 'needs care right now',
  Liability: 'is a liability right now',
  'Insufficient Data': 'is still building its read',
}

const STRENGTH: Record<ReadFactorKey, string> = {
  directionWindow: 'it starts on line',
  distanceWindow: 'the distance is dependable',
  flightQuality: 'the flight is steady',
  patternStability: 'the pattern is holding',
}

const WEAKNESS: Record<ReadFactorKey, string> = {
  directionWindow: 'the direction wanders',
  distanceWindow: 'the distance is the problem',
  flightQuality: 'the flight is inconsistent',
  patternStability: 'the pattern is shifting',
}

const FACTOR_NAME: Record<ReadFactorKey, string> = {
  distanceWindow: 'Carry consistency',
  directionWindow: 'Direction control',
  flightQuality: 'Shot behavior',
  patternStability: 'The pattern',
}

const round = (value: number) => Math.round(value)

const scored = (factors: readonly ReadFactor[]) =>
  factors.filter((factor): factor is ReadFactor & { value: number } =>
    typeof factor.value === 'number' && Number.isFinite(factor.value))

/** "below your usual" with the size of the change in the words. */
export const changeWords = (delta: number): string | null => {
  const size = Math.abs(delta)
  if (size < 10) return null
  const side = delta < 0 ? 'below' : 'above'
  if (size >= 30) return `well ${side} your usual`
  if (size >= 15) return `${side} your usual`
  return `a little ${side} your usual`
}

const joinClauses = (parts: readonly string[]) => {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const capitalize = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text)

const verdictLine = (input: LooperReadInput, ranked: ReadonlyArray<ReadFactor & { value: number }>) => {
  const head = `${input.clubLabel} ${VERDICT[input.call]}`
  if (ranked.length < 2 || input.call === 'Insufficient Data') return `${head}.`
  const best = ranked[0]
  const worst = ranked[ranked.length - 1]
  if (worst.value >= STRONG) {
    return `${head}: ${STRENGTH[best.key]} and ${STRENGTH[ranked[1].key]}.`
  }
  if (best.value < WEAK) {
    return `${head}: ${WEAKNESS[worst.key]} and ${WEAKNESS[ranked[ranked.length - 2].key]}.`
  }
  if (best.value - worst.value >= 15) {
    return `${head}: ${STRENGTH[best.key]}, but ${WEAKNESS[worst.key]}.`
  }
  return `${head}: nothing stands out either way.`
}

const evidenceLine = (input: LooperReadInput, factors: ReadonlyArray<ReadFactor & { value: number }>) => {
  const parts: string[] = []
  if (typeof input.carryLow === 'number' && typeof input.carryHigh === 'number') {
    parts.push(`8 of 10 swings carry ${round(input.carryLow)}–${round(input.carryHigh)}`)
  }

  const mover = [...factors]
    .filter((factor) => typeof factor.delta === 'number' && changeWords(factor.delta) !== null)
    .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!))[0]
  if (mover) {
    const name = FACTOR_NAME[mover.key]
    parts.push(`${parts.length ? name.toLowerCase() : name} is ${changeWords(mover.delta!)}`)
  }

  if (typeof input.mishitRate === 'number' && input.mishitRate >= MISHIT_MENTION_RATE) {
    const severe =
      typeof input.severeRate === 'number' && input.severeRate >= SEVERE_MENTION_RATE
        ? `, ${round(input.severeRate * 100)}% severe`
        : ''
    parts.push(`${round(input.mishitRate * 100)}% come off as mishits${severe}`)
  }

  if (parts.length === 0) {
    return typeof input.swings === 'number'
      ? `${input.swings} swings so far, and nothing has moved much against your usual.`
      : 'Nothing has moved much against your usual.'
  }
  return `${capitalize(joinClauses(parts))}.`
}

const aimClause = (input: LooperReadInput) => {
  const miss = input.missOffline
  if (typeof miss !== 'number' || Math.abs(miss) < AIM_OFFSET_MIN_YARDS) return null
  if ((input.swings ?? 0) < AIM_OFFSET_MIN_SWINGS) return null
  return `aim ${round(Math.abs(miss))} yd ${miss < 0 ? 'right' : 'left'}`
}

const courseLine = (input: LooperReadInput, ranked: ReadonlyArray<ReadFactor & { value: number }>) => {
  if (input.call === 'Insufficient Data') {
    return 'Keep the target simple until a few more range swings settle the read.'
  }
  if (input.call === 'Liability') {
    return 'Take a safer club unless the hole leaves you no choice.'
  }

  const aim = aimClause(input)
  const worst = ranked[ranked.length - 1]
  const tight =
    typeof input.carryLow === 'number' &&
    typeof input.carryHigh === 'number' &&
    input.carryHigh - input.carryLow <= 15

  let pick: string
  if ((input.call === 'Attack' || input.call === 'Play') && tight && typeof input.stockCarry === 'number') {
    pick = `Trust ${round(input.stockCarry)} carry`
  } else if (typeof input.carryLow === 'number' && typeof input.carryHigh === 'number') {
    pick = `Hit it when anything from ${round(input.carryLow)} to ${round(input.carryHigh)} works`
  } else if (typeof input.stockCarry === 'number') {
    pick = `Plan on ${round(input.stockCarry)} carry`
  } else {
    pick = 'Play to the middle of the green'
  }
  const first = aim ? `${pick} and ${aim}.` : `${pick}.`

  let caution = ''
  if (worst && worst.value < WEAK) {
    if (worst.key === 'distanceWindow') {
      caution = ' With trouble short or long, it isn’t the club for that shot.'
    } else if (worst.key === 'directionWindow' && typeof input.missOffline === 'number' && Math.abs(input.missOffline) >= AIM_OFFSET_MIN_YARDS) {
      caution = ` Keep trouble off the ${input.missOffline < 0 ? 'left' : 'right'}; that is where the misses go.`
    } else if (worst.key === 'directionWindow') {
      caution = ' With trouble on both sides, take a club you trust more.'
    } else {
      caution = ' Give it the widest part of the target.'
    }
  } else if (input.call === 'Careful') {
    caution = ' Keep the trouble out of play.'
  }
  return `${first}${caution}`
}

export const buildLooperRead = (input: LooperReadInput): LooperRead => {
  const factors = scored(input.factors)
  const ranked = [...factors].sort((a, b) => b.value - a.value)
  return {
    primary: verdictLine(input, ranked),
    explanation: evidenceLine(input, factors),
    implication: courseLine(input, ranked),
  }
}
