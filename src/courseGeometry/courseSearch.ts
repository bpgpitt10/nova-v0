/** Course search (Start a Round): pure matching, no UI. */

const normalize = (value: string) =>
  value.normalize('NFKD').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** How well a course matches what's typed: 0 = not at all. */
export const courseSearchScore = (
  entry: Readonly<{ name: string; location: string; gsproAliases: readonly string[] }>,
  query: string,
): number => {
  const q = normalize(query)
  if (!q) return 1
  const name = normalize(entry.name)
  const words = name.split(' ')
  const terms = q.split(' ')
  const hay = [name, normalize(entry.location), ...entry.gsproAliases.map(normalize)].join(' ')
  if (!terms.every((term) => hay.includes(term))) return 0
  if (name.startsWith(q) || entry.gsproAliases.some((alias) => normalize(alias).startsWith(q))) return 4
  if (terms.every((term) => words.some((word) => word.startsWith(term)))) return 3
  if (terms.every((term) => name.includes(term))) return 2
  return 1
}

