export const GREYWOLF_SCORECARD_SOURCE = 'Greywolf Golf Course 2025 score card'

export const GREYWOLF_TEE_YARDAGES: Readonly<Record<string, readonly number[]>> = {
  grey: [406, 389, 513, 490, 570, 200, 418, 446, 181, 580, 339, 181, 441, 527, 176, 390, 446, 447],
  black: [383, 372, 490, 462, 545, 175, 382, 419, 153, 557, 327, 158, 416, 509, 159, 369, 418, 401],
  blue: [361, 345, 428, 427, 524, 155, 354, 395, 130, 535, 318, 131, 376, 494, 129, 349, 377, 372],
  gold: [277, 345, 391, 394, 474, 155, 354, 345, 130, 480, 308, 131, 331, 429, 129, 325, 303, 327],
  white: [277, 284, 391, 360, 434, 142, 323, 240, 105, 388, 308, 102, 310, 350, 129, 305, 303, 327],
  green: [260, 225, 391, 360, 434, 77, 272, 240, 94, 388, 235, 102, 250, 350, 88, 250, 303, 266],
}

const displayNames: Readonly<Record<string, string>> = {
  grey: 'Grey',
  black: 'Black',
  blue: 'Blue',
  gold: 'Gold',
  white: 'White',
  green: 'Green',
}

export const greywolfExpectedYardage = (teeSet: string, holeNumber: number) => {
  const row = GREYWOLF_TEE_YARDAGES[teeSet.trim().toLowerCase()]
  if (!row || holeNumber < 1 || holeNumber > row.length) return null
  return row[holeNumber - 1] ?? null
}

export const inferGreywolfTeeAliases = ({
  holeNumber,
  selectedAnchorDistanceYds,
  candidateDistanceYds,
}: {
  holeNumber: number
  selectedAnchorDistanceYds: number | null
  candidateDistanceYds: number | null
}) => {
  if (
    selectedAnchorDistanceYds == null
    || candidateDistanceYds == null
    || !Number.isFinite(selectedAnchorDistanceYds)
    || !Number.isFinite(candidateDistanceYds)
  ) return [] as string[]

  const official = Object.entries(GREYWOLF_TEE_YARDAGES)
    .flatMap(([teeSet, values]) => {
      const yardage = values[holeNumber - 1]
      return Number.isFinite(yardage) ? [{ teeSet, yardage }] : []
    })
  if (official.length === 0) return [] as string[]

  // The cached OSM package measures tee -> green centroid, while the scorecard
  // yardage is a tee -> scored-hole yardage. Estimate that per-hole offset from
  // the package's selected anchor, then apply the same offset to the other tee
  // candidates. This is only an assumption layer; completed GSPro shots are the
  // evidence we use to confirm or challenge it over time.
  const anchorResiduals = official
    .map((entry) => ({ ...entry, residual: Math.abs(entry.yardage - selectedAnchorDistanceYds) }))
    .sort((left, right) => left.residual - right.residual)
  const bestAnchor = anchorResiduals[0]
  if (!bestAnchor || bestAnchor.residual > 30) return [] as string[]

  const centroidOffset = bestAnchor.yardage - selectedAnchorDistanceYds
  const scored = official
    .map((entry) => ({
      ...entry,
      residual: Math.abs((entry.yardage - centroidOffset) - candidateDistanceYds),
    }))
    .sort((left, right) => left.residual - right.residual)
  const bestResidual = scored[0]?.residual ?? Number.POSITIVE_INFINITY
  if (bestResidual > 5) return [] as string[]

  return scored
    .filter((entry) => entry.residual <= Math.max(2, bestResidual + 0.5))
    .map((entry) => displayNames[entry.teeSet] ?? entry.teeSet)
}
