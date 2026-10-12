/**
 * Research-only cross-frame registration: canonical GSPro minimap pixels ->
 * existing Looper hole-local yard coordinates.
 *
 * NOT a new hazard classifier, GSPro image registration, GSPro world rotation,
 * tee identification, or permission to start a round/set aim. Existing SIFT
 * zoom/tee registration is performed by the Windows Companion BEFORE this
 * module receives its canonical pixels.
 *
 * Pin/green-centroid coordinates are not interchangeable: only independently
 * reviewed, exact physical landmark correspondences are eligible. Two fitted
 * anchors are insufficient for proof; a third, off-axis holdout is mandatory.
 */
import type { CoursePointYds } from './types'

export type CrossFrameAnchorKind =
  | 'bunker-edge' | 'green-edge' | 'fairway-edge'
  | 'water-edge' | 'cartpath-corner' | 'pin'

export type CrossFrameLandmark = Readonly<{
  featureId: string
  kind: CrossFrameAnchorKind
  nativeFeatureId: string
  gsproCanonicalPixel: readonly [number, number]
  courseLocalYds: CoursePointYds
  role: 'fit' | 'holdout'
  evidence: 'independently-reviewed' | 'inferred'
  /** A polygon centroid or estimated green center is NOT an exact GSPro pin. */
  spatialAccuracy: 'exact' | 'estimated'
}>

export type CrossFrameEvidence = Readonly<{
  expected: {
    courseId: string
    gsproCourseKey: string
    roundId: string | number
    holeNumber: number
  }
  native: {
    courseId: string
    gsproCourseKey: string
    roundId: string | number
    holeNumber: number
    observedAt: string
    frame: 'canonical-tee-minimap-roi'
    minimapStatus: string
    registrationStatus: string
    teeScaleYardsPerPixel: number | null
    whitePinErrorPixels: number | null
  }
  landmarks: readonly CrossFrameLandmark[]
}>

export type CrossFrameResult = Readonly<{
  status: 'blocked' | 'research-candidate'
  reason: string
  fitCount: number
  holdoutCount: number
  scaleYardsPerPixel: number | null
  scaleDifferencePercent: number | null
  fitRmsYds: number | null
  holdoutMaxErrorYds: number | null
  holdoutOffAxisYds: number | null
  /** Maps canonical GSPro [pixelX,pixelY] to Looper [rightYds,forwardYds]. */
  canonicalPixelToCourseLocal: Readonly<{
    matrix2x3: readonly [readonly [number, number, number], readonly [number, number, number]]
  }> | null
  verifiedForPlay: false
  authorizesNativeAim: false
  canPublishCourse: false
}>

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const valid = (p: readonly number[]) => p.length === 2 && p.every(finite)
const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1])
const pair = (x: number, y: number) => [x, y] as const
const round = (n: number) => Math.round(n * 10000) / 10000

export const applyCourseLandmarkTransform = (
  matrix: NonNullable<CrossFrameResult['canonicalPixelToCourseLocal']>['matrix2x3'],
  pixel: readonly [number, number],
): CoursePointYds => [
  matrix[0][0] * pixel[0] + matrix[0][1] * pixel[1] + matrix[0][2],
  matrix[1][0] * pixel[0] + matrix[1][1] * pixel[1] + matrix[1][2],
]

const rejected = (
  reason: string,
  fitCount = 0, holdoutCount = 0,
  info: Partial<Pick<CrossFrameResult,
    'scaleYardsPerPixel' | 'scaleDifferencePercent' | 'fitRmsYds'
    | 'holdoutMaxErrorYds' | 'holdoutOffAxisYds'>> = {},
): CrossFrameResult => ({
  status: 'blocked', reason, fitCount, holdoutCount,
  scaleYardsPerPixel: info.scaleYardsPerPixel ?? null,
  scaleDifferencePercent: info.scaleDifferencePercent ?? null,
  fitRmsYds: info.fitRmsYds ?? null,
  holdoutMaxErrorYds: info.holdoutMaxErrorYds ?? null,
  holdoutOffAxisYds: info.holdoutOffAxisYds ?? null,
  canonicalPixelToCourseLocal: null,
  verifiedForPlay: false, authorizesNativeAim: false, canPublishCourse: false,
})

/**
 * Least-squares orientation-preserving 2D similarity (uniform scale + rotation
 * + translation). Deliberately not an affine warp: distortion/shear should
 * FAIL, because distorted obstacle locations cannot support shot safety.
 *
 * A passing candidate can be inspected offline only. Two independent feature
 * matches plus a distinct cross-axis holdout, separate native distance scale
 * and fresh SAME course/round/hole are all required.
 */
export const evaluateGsproToCourseLandmarkRegistration = (
  input: CrossFrameEvidence,
  nowMs: number = Date.now(),
): CrossFrameResult => {
  const f = input.landmarks.filter((x) => x.role === 'fit')
  const h = input.landmarks.filter((x) => x.role === 'holdout')
  const bad = (reason: string, info?: Parameters<typeof rejected>[3]) =>
    rejected(reason, f.length, h.length, info)
  const { expected, native } = input
  if (!expected.courseId || !expected.gsproCourseKey || !String(expected.roundId)
    || native.courseId !== expected.courseId
    || native.gsproCourseKey !== expected.gsproCourseKey
    || String(native.roundId) !== String(expected.roundId)
    || native.holeNumber !== expected.holeNumber
    || !Number.isInteger(expected.holeNumber) || expected.holeNumber < 1 || expected.holeNumber > 18) {
    return bad('Course, round, hole or GSPro course key does not match canonical Live Caddie.')
  }
  const observed = Date.parse(native.observedAt)
  if (!finite(nowMs) || !finite(observed) || observed > nowMs + 5000
    || nowMs - observed > 30000) {
    return bad('GSPro frame is stale or time ordering is inconsistent.')
  }
  if (native.frame !== 'canonical-tee-minimap-roi'
    || native.minimapStatus !== 'markers_found'
    || !['tee_anchor_candidate_cached', 'registered_candidate_unverified'].includes(native.registrationStatus)
    || !finite(native.teeScaleYardsPerPixel) || native.teeScaleYardsPerPixel <= 0
    || (native.registrationStatus === 'registered_candidate_unverified'
      && (!finite(native.whitePinErrorPixels) || native.whitePinErrorPixels > 3))) {
    return bad('Native tee scale, same-frame registration or independent pin check is insufficient.')
  }
  if (f.length < 2 || h.length < 1) {
    return bad('At least two matched fit landmarks and a separate holdout are required.')
  }
  const all = [...f, ...h]
  if (all.some((x) => !x.featureId || !x.nativeFeatureId || !valid(x.gsproCanonicalPixel)
    || !valid(x.courseLocalYds) || x.evidence !== 'independently-reviewed'
    || x.spatialAccuracy !== 'exact')) {
    return bad('Landmark correspondence is incomplete, inferred or only an approximate map centroid.')
  }
  const osmIds = all.map((x) => x.featureId)
  const nativeIds = all.map((x) => x.nativeFeatureId)
  if (new Set(osmIds).size !== all.length || new Set(nativeIds).size !== all.length) {
    return bad('Holdout landmark must be physically distinct from each fitted reference.')
  }
  let maxBaselineYds = 0
  let maxBaselinePx = 0
  let endpoints: [CrossFrameLandmark, CrossFrameLandmark] | null = null
  for (let i = 0; i < f.length; i++) {
    for (let j = i + 1; j < f.length; j++) {
      const length = distance(f[i].courseLocalYds, f[j].courseLocalYds)
      if (length > maxBaselineYds) {
        maxBaselineYds = length
        maxBaselinePx = distance(f[i].gsproCanonicalPixel, f[j].gsproCanonicalPixel)
        endpoints = [f[i], f[j]]
      }
    }
  }
  if (!endpoints || maxBaselineYds < 40 || maxBaselinePx < 40) {
    return bad('Two landmarks must span at least 40 yards and 40 screen pixels.')
  }
  const sx = f.reduce((v, x) => v + x.gsproCanonicalPixel[0], 0) / f.length
  const sy = f.reduce((v, x) => v + x.gsproCanonicalPixel[1], 0) / f.length
  const tx = f.reduce((v, x) => v + x.courseLocalYds[0], 0) / f.length
  const ty = f.reduce((v, x) => v + x.courseLocalYds[1], 0) / f.length
  let aa = 0, bb = 0, den = 0
  for (const x of f) {
    const u = x.gsproCanonicalPixel[0] - sx
    const v = x.gsproCanonicalPixel[1] - sy
    const p = x.courseLocalYds[0] - tx
    const q = x.courseLocalYds[1] - ty
    aa += u * p + v * q
    bb += u * q - v * p
    den += u * u + v * v
  }
  if (den < 1 || !finite(den)) return bad('Degenerate landmark geometry.')
  const a = aa / den
  const b = bb / den
  const scale = Math.hypot(a, b)
  if (!finite(scale) || scale <= 0) return bad('Invalid similarity scale.')
  const matrix = [
    [a, -b, tx - a * sx + b * sy],
    [b, a, ty - b * sx - a * sy],
  ] as const
  const fitRms = Math.sqrt(f.reduce((v, x) =>
    v + distance(applyCourseLandmarkTransform(matrix, x.gsproCanonicalPixel), x.courseLocalYds) ** 2, 0) / f.length)
  const scaleDiff = Math.abs(scale / native.teeScaleYardsPerPixel - 1) * 100
  const errors = h.map((x) =>
    distance(applyCourseLandmarkTransform(matrix, x.gsproCanonicalPixel), x.courseLocalYds))
  const holdoutMax = Math.max(...errors)
  const [p, q] = endpoints
  const delta = pair(q.courseLocalYds[0] - p.courseLocalYds[0],
    q.courseLocalYds[1] - p.courseLocalYds[1])
  const holdoutOffAxis = Math.max(...h.map((x) => {
    const dx = x.courseLocalYds[0] - p.courseLocalYds[0]
    const dy = x.courseLocalYds[1] - p.courseLocalYds[1]
    return Math.abs(dx * delta[1] - dy * delta[0]) / maxBaselineYds
  }))
  const diagnostics = {
    scaleYardsPerPixel: round(scale),
    scaleDifferencePercent: round(scaleDiff),
    fitRmsYds: round(fitRms),
    holdoutMaxErrorYds: round(holdoutMax),
    holdoutOffAxisYds: round(holdoutOffAxis),
  }
  if (holdoutOffAxis < 8) {
    return bad('Holdout is near the fit axis; cannot independently reject reflection/reversed holes.', diagnostics)
  }
  if (fitRms > 2 || holdoutMax > 5 || scaleDiff > 8) {
    return bad('Cross-frame residual or native waypoint scale disagreement exceeded research gates.', diagnostics)
  }
  return {
    status: 'research-candidate',
    reason: 'Numerical fit and independent holdout passed; GSPro feature matches still require physical review. Never enables play, publishing or clicking.',
    fitCount: f.length, holdoutCount: h.length, ...diagnostics,
    canonicalPixelToCourseLocal: { matrix2x3: matrix },
    verifiedForPlay: false, authorizesNativeAim: false, canPublishCourse: false,
  }
}
