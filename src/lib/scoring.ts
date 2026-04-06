import type { Club, ClubSummary, Shot } from '../types'

export const scoreClub = (club: Club, shots: Shot[]): ClubSummary => {
  const clubShots = shots.filter((shot) => shot.club === club)
  const includedShots = clubShots.filter((shot) => shot.included)
  const carryShots = includedShots.filter(
    (shot): shot is Shot & { carryYards: number } =>
      typeof shot.carryYards === 'number',
  )

  const averageCarryYards =
    carryShots.length > 0
      ? Math.round(
          carryShots.reduce((sum, shot) => sum + shot.carryYards, 0) /
            carryShots.length,
        )
      : null

  let confidence: ClubSummary['confidence'] = 'No data'
  if (includedShots.length >= 10) {
    confidence = 'High'
  } else if (includedShots.length >= 5) {
    confidence = 'Medium'
  } else if (includedShots.length > 0) {
    confidence = 'Low'
  }

  return {
    club,
    totalShots: includedShots.length,
    includedShots: includedShots.length,
    averageCarryYards,
    confidence,
  }
}
