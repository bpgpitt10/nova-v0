import type { Club } from './bagConfig'
import { getShotVariantsForClub, STOCK_SHOT_VARIANT_ID, type ShotVariant } from './shotVariants'

/**
 * Named shot variants by voice (Brian, 27 Nov): "Looper, seven iron" is the full
 * swing; "Looper, seven iron one inch choke down" is the variant the player
 * named "1 inch choke down". The page turns each variant's name into the words
 * a player would say and sends them to the companion, which listens for them
 * after the club and reports the phrase back.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** 0..99 as words: 52 -> "fifty two". */
export const numberWords = (value: number): string | null => {
  if (!Number.isInteger(value) || value < 0 || value > 99) return null
  if (value < 20) return ONES[value]
  return value % 10 === 0 ? TENS[value / 10] : `${TENS[Math.floor(value / 10)]} ${ONES[value % 10]}`
}

const FRACTIONS: Record<string, string> = { '3/4': ' three quarter ', '1/2': ' half ', '1/4': ' quarter ', '1/3': ' third ', '2/3': ' two third ' }
const CLUB_WORDS: Record<string, string> = { i: 'iron', w: 'wood', h: 'hybrid' }
// Spoken the companion's way (helpers/looper_voice.py CLUB_PHRASES).
const WEDGE_WORDS: Record<string, string> = { pw: 'pitching wedge', aw: 'approach wedge', gw: 'gap wedge', sw: 'sand wedge', lw: 'lob wedge' }
const MAX_WORDS = 6

const clubSpoken = (club: string): string[] => {
  const id = club.toLowerCase()
  const said = [id]
  const numbered = /^(\d)([iwh])$/.exec(id)
  if (numbered) said.push(`${numberWords(+numbered[1])} ${CLUB_WORDS[numbered[2]]}`, `${numbered[1]} ${CLUB_WORDS[numbered[2]]}`)
  if (WEDGE_WORDS[id]) said.push(WEDGE_WORDS[id])
  if (id === 'driver') said.push('driver')
  return said
}

/**
 * A variant's name as the words a player says: "1 inch choke down" -> "one inch choke down",
 * '7i 3/4' -> "three quarter", 'Choke 1"' -> "choke one inch". Null when nothing sayable is left
 * or it is too long to say in one breath.
 */
export const spokenVariantPhrase = (name: string, club?: string): string | null => {
  let text = ` ${name.toLowerCase()} `
  for (const [fraction, words] of Object.entries(FRACTIONS)) text = text.split(fraction).join(words)
  text = text.replace(/%/g, ' percent ').replace(/"|”|“|''/g, ' inch ').replace(/[-_/.,:;()]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ')
  // A name that starts with its own club ("7i choke down") drops it: the club is said already.
  let words = text.split(/\s+/).filter(Boolean)
  if (club) {
    for (const said of clubSpoken(club).sort((a, b) => b.split(' ').length - a.split(' ').length)) {
      const parts = said.split(' ')
      if (parts.every((part, index) => words[index] === part)) { words = words.slice(parts.length); break }
    }
  }
  // "1in" is "1 in": digits and letters run together come apart once the club is gone.
  words = words.flatMap((word) => word.match(/\d+|[a-z]+/g) ?? [])
  const out: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (/^\d+$/.test(word)) {
      const spoken = numberWords(+word)
      if (!spoken) return null
      out.push(...spoken.split(' '))
      continue
    }
    // "1 in" / "2 ins" after a number is inches; "in" elsewhere stays a word.
    if (['in', 'ins', 'inches'].includes(word) && index > 0 && /^\d+$/.test(words[index - 1])) { out.push('inch'); continue }
    out.push(word)
  }
  if (out.length === 0 || out.length > MAX_WORDS) return null
  return out.join(' ')
}

// What people say for a swing length: "fifty percent" is also "half".
const PERCENT_WORDS: Record<string, string> = { 'twenty five': 'quarter', fifty: 'half', 'seventy five': 'three quarter' }

/**
 * Every way to say the name: the phrase itself, then the same without "percent"
 * ("lob wedge 50%": "fifty percent", "fifty", "half"). Duplicates dropped.
 */
export const spokenVariantPhrases = (name: string, club?: string): string[] => {
  const phrase = spokenVariantPhrase(name, club)
  if (!phrase) return []
  const said = [phrase]
  const words = phrase.split(' ')
  const at = words.indexOf('percent')
  if (at > 0) {
    // The number before "percent" is one or two number words ("fifty", "seventy five").
    const two = at > 1 && TENS.includes(words[at - 2]) && ONES.includes(words[at - 1]) ? 2 : 1
    const number = words.slice(at - two, at).join(' ')
    const around = (middle: string[]) => [...words.slice(0, at - two), ...middle, ...words.slice(at + 1)].join(' ')
    said.push(around(number.split(' ')))
    if (PERCENT_WORDS[number]) said.push(around(PERCENT_WORDS[number].split(' ')))
  }
  return [...new Set(said)]
}

/** "club:phrase" pairs for the companion: each named variant the player can say, per bag club. "*" = any club. */
export const voiceVariantEntries = (clubs: readonly Club[]): string[] => {
  const entries = new Set<string>()
  for (const club of clubs) {
    for (const variant of getShotVariantsForClub(club)) {
      if (variant.id === STOCK_SHOT_VARIANT_ID) continue
      for (const phrase of spokenVariantPhrases(variant.name, variant.club)) entries.add(`${variant.club ? club : '*'}:${phrase}`)
    }
  }
  return [...entries].sort()
}

/** The variant the companion heard for this club, by its spoken phrase. */
export const resolveVoiceVariant = (club: Club, phrase: string): ShotVariant | null =>
  getShotVariantsForClub(club).find((variant) =>
    variant.id !== STOCK_SHOT_VARIANT_ID && spokenVariantPhrases(variant.name, variant.club).includes(phrase)) ?? null
