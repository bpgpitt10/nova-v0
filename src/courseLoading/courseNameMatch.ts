// Pure name matching shared by course loading and native positions (no network).

const MATCH_FILLER_WORDS = new Set([
  'the', 'golf', 'club', 'course', 'courses', 'country', 'cc', 'gc', 'links', 'resort', 'at', 'and', 'of',
])

/** Name tokens for matching: punctuation dropped, so "Payne's" and "Paynes" agree. */
const matchTokens = (name: string) =>
  name.normalize('NFKD').toLowerCase()
    .replace(/['\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !MATCH_FILLER_WORDS.has(word))

/** 1 = same name, ~0.8 = one name contains the other, otherwise word overlap. */
export const courseNameMatchScore = (candidate: string, target: string) => {
  const a = matchTokens(candidate)
  const b = matchTokens(target)
  if (!a.length || !b.length) return 0
  const joinedA = a.join('')
  const joinedB = b.join('')
  if (joinedA === joinedB) return 1
  if (joinedA.includes(joinedB) || joinedB.includes(joinedA)) return 0.8
  const setA = new Set(a)
  const shared = b.filter((word) => setA.has(word)).length
  return shared / new Set([...a, ...b]).size
}
