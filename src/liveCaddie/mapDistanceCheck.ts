/**
 * Does Looper's picture of this tee shot match GSPro's?
 *
 * Before a tee shot GSPro reports where the ball starts and how far the pin is.
 * If Looper's own ball-to-pin distance is far from that, its tee or pin is from
 * a different layout (Purbeck, 21 Nov: GSPro had 158, 124, 169 and 156 yd par
 * 3s; Looper ranked clubs for a much longer hole and picked a 3 wood). A pick
 * from the wrong hole is worse than none, so the page holds it.
 *
 * GSPro's tee distance follows the aim route on a dogleg, so it can be longer
 * than Looper's straight line (Royal New Kent 4: 371 against 342). That is not
 * a mismatch; only a clearly longer or much shorter map distance is.
 */
export const MAP_LONGER_MIN_YDS = 20
export const MAP_LONGER_SHARE = 0.15
export const MAP_SHORTER_SHARE = 0.25

export const mapDistanceDisagrees = (mapYds: number | null, gsproYds: number | null): boolean => {
  if (mapYds == null || gsproYds == null) return false
  if (!Number.isFinite(mapYds) || !Number.isFinite(gsproYds) || gsproYds <= 45 || mapYds <= 0) return false
  const diff = mapYds - gsproYds
  if (diff > Math.max(MAP_LONGER_MIN_YDS, gsproYds * MAP_LONGER_SHARE)) return true
  return -diff > Math.max(MAP_LONGER_MIN_YDS * 2, gsproYds * MAP_SHORTER_SHARE)
}
