// Recommendation snapshot across every loaded course and hole, for comparing
// engine changes. Runs the real club/aim recommender (evaluateAimLab) for a
// fixed, realistic amateur bag from (a) the tee and (b) a fairway spot ~150 yd
// from the pin on par 4s and 5s.
//
//   node tools/snapshot-live-recommendations.mjs out.json
//
// Not the full worker: per-club landing-elevation re-solve and live wind/lie are
// left out (elevation 0, calm), so before/after runs differ only by engine code.
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'

const outPath = process.argv[2] ?? 'recommendation-snapshot.json'
const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const path = new URL(String(url), 'http://local').pathname
  try {
    return new Response(await readFile(`public${path}`), { status: 200, headers: { 'content-type': 'application/json' } })
  } catch {
    return new Response('missing', { status: 404 })
  }
}

// ---- Fixed amateur bag (about a 12 handicap), 24 shots per club over 3 sessions.
const NOW = Date.parse('2026-10-31T12:00:00Z')
const BAG = [
  // club, carry, total, carrySd, offlineSd, ballSpeed, launch, spin
  ['Driver', 235, 255, 12, 18, 150, 12, 2700],
  ['3W', 215, 232, 10, 15, 140, 12, 3500],
  ['4H', 195, 207, 9, 13, 130, 14, 4200],
  ['5i', 180, 190, 8, 11, 122, 15, 5000],
  ['6i', 170, 179, 7, 10, 117, 16.5, 5600],
  ['7i', 158, 166, 7, 9, 111, 18, 6300],
  ['8i', 146, 152, 6, 8, 105, 20, 7200],
  ['9i', 134, 139, 6, 7, 99, 23, 8000],
  ['PW', 122, 126, 5, 6, 92, 26, 8800],
  ['GW', 108, 111, 5, 6, 84, 29, 9300],
  ['SW', 92, 94, 5, 5, 76, 32, 9800],
]
// Deterministic standard-normal quantiles for 22 good shots, plus 2 mishits per club.
const Z = Array.from({ length: 22 }, (_, i) => {
  const p = (i + 0.5) / 22
  // Acklam-lite: good enough for a fixture.
  const t = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p))
  const z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t)
  return p < 0.5 ? -z : z
})
const PERM = [5, 17, 2, 11, 20, 8, 14, 0, 19, 6, 12, 3, 16, 9, 21, 1, 13, 7, 18, 4, 10, 15]
const sessions = [0, 1, 2].map((sessionIndex) => ({
  id: `snapshot-bag-${sessionIndex}`,
  startedAt: new Date(NOW - (3 - sessionIndex) * 86400000).toISOString(),
  endedAt: new Date(NOW - (3 - sessionIndex) * 86400000 + 3600000).toISOString(),
  shots: [],
}))
BAG.forEach(([club, carry, total, carrySd, offSd, speed, launch, spin], clubIndex) => {
  const shots = Z.map((zc, i) => {
    const zo = Z[PERM[i]]
    return { carry: carry + zc * carrySd, total: total + zc * carrySd, off: zo * offSd, speed: speed + zc * 1.5 }
  })
  shots.push({ carry: carry * 0.78, total: total * 0.82, off: -offSd * 2.2, speed: speed * 0.9 })
  shots.push({ carry: carry * 0.9, total: total * 0.9, off: offSd * 2.6, speed: speed * 0.95 })
  shots.forEach((shot, i) => {
    sessions[i % 3].shots.push({
      id: `${club}-${i}`, club, included: true, enrichmentStatus: 'enriched', source: 'simread',
      capturedAt: new Date(NOW - (3 - (i % 3)) * 86400000 + clubIndex * 60000 + i * 1000).toISOString(),
      carryYards: Math.round(shot.carry * 10) / 10,
      totalYards: Math.round(shot.total * 10) / 10,
      offlineYards: Math.round(shot.off * 10) / 10,
      ballSpeedMph: Math.round(shot.speed * 10) / 10,
      launchAngleDeg: launch,
      spinRpm: spin,
    })
  })
})

try {
  const { courseRegistry } = await vite.ssrLoadModule('/src/courseGeometry/courseCatalog.ts')
  const { loadCourseHoleGeometry } = await vite.ssrLoadModule('/src/courseGeometry/courseProvider.ts')
  const { fairwayCorridorAtForwardY } = await vite.ssrLoadModule('/src/courseGeometry/geometry.ts')
  const { evaluateAimLab } = await vite.ssrLoadModule('/src/liveCaddie/aimOptimization.ts')
  const { nextStateValueForAimCandidate } = await vite.ssrLoadModule('/src/liveCaddie/aimDecisionRanking.ts')

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  // Mirrors LiveCaddiePage chooseLiveLandingTarget.
  const liveTarget = (hole, ball, pin) => {
    const d = dist(ball, pin)
    if (d <= 260) return pin
    const landing = Math.min(220, d * 0.65)
    const f = [(pin[0] - ball[0]) / d, (pin[1] - ball[1]) / d]
    const raw = [ball[0] + f[0] * landing, ball[1] + f[1] * landing]
    const corridor = fairwayCorridorAtForwardY(hole, raw[1])
    return corridor ? [corridor.centerRightYds, raw[1]] : raw
  }
  const approachSpot = (hole, pin) => {
    let best = null
    for (let y = pin[1] - 200; y <= pin[1] - 80; y += 1) {
      const corridor = fairwayCorridorAtForwardY(hole, y)
      if (!corridor) continue
      const p = [corridor.centerRightYds, y]
      const error = Math.abs(dist(p, pin) - 150)
      if (!best || error < best.error) best = { p, error }
    }
    return best && best.error < 6 ? best.p : null
  }
  const summarize = (evaluations) => {
    const top = evaluations.find((e) => e.decisionRank === 1) ?? null
    const row = (e) => {
      const c = e?.bestCandidate
      const r = c?.riskProfile
      const v = c ? nextStateValueForAimCandidate(c) : null
      return e ? {
        club: e.club,
        aimOffsetYds: c?.aimOffsetYds ?? null,
        expectedStrokes: v?.expectedFutureStrokes ?? null,
        water: (r?.bySurface?.water ?? 0) + (r?.bySurface?.penalty ?? 0),
        bunker: r?.bySurface?.bunker ?? 0,
        catastrophe: r?.catastrophe ?? null,
        reason: (e.decisionReason ?? '').split(':')[0],
      } : null
    }
    return {
      top: row(top),
      ranked: evaluations
        .filter((e) => e.decisionRank != null)
        .sort((a, b) => a.decisionRank - b.decisionRank)
        .slice(0, 4)
        .map((e) => row(e)),
    }
  }

  const results = []
  for (const course of courseRegistry) {
    for (let holeNumber = 1; holeNumber <= 18; holeNumber += 1) {
      let hole
      try {
        hole = await loadCourseHoleGeometry(course.id, holeNumber)
      } catch (error) {
        results.push({ course: course.id, hole: holeNumber, error: String(error?.message ?? error) })
        continue
      }
      const pin = hole.markers.pin
      const tee = hole.markers.tee
      if (!pin || !tee) continue
      const positions = [{ position: 'tee', ball: tee, env: { shotOrigin: 'tee', surfaceOverride: 'tee' } }]
      if ((hole.par ?? 4) >= 4) {
        const spot = approachSpot(hole, pin)
        if (spot) positions.push({ position: 'approach-150', ball: spot, env: { shotOrigin: 'non-tee', surfaceOverride: 'fairway' } })
      }
      for (const { position, ball, env } of positions) {
        const target = liveTarget(hole, ball, pin)
        const started = Date.now()
        const evaluations = evaluateAimLab(sessions, hole, ball, target, { ...env, exactPinLocalYds: pin }, NOW)
        results.push({
          course: course.id, hole: holeNumber, par: hole.par ?? null, position,
          ball: ball.map((v) => Math.round(v * 10) / 10), toPinYds: Math.round(dist(ball, pin)),
          ms: Date.now() - started,
          ...summarize(evaluations),
        })
      }
      process.stderr.write(`${course.id} ${holeNumber}\n`)
    }
  }
  await writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 1))
  console.log(`snapshot: ${results.length} positions → ${outPath}`)
} finally {
  globalThis.fetch = realFetch
  await vite.close()
}
