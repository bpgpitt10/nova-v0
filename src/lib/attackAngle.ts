import type { Shot } from '../types'

/**
 * Attack angle (club AoA, degrees; positive = hitting up). The launch monitor
 * writes exactly 0 when it didn't read the club (those rows also carry 0 loft),
 * so 0 is treated as missing rather than a level strike.
 */
export const attackAngleValue = (shot: Shot): number | undefined =>
  typeof shot.clubAoa === 'number' && Number.isFinite(shot.clubAoa) && shot.clubAoa !== 0
    ? shot.clubAoa
    : undefined
