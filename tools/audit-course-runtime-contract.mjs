#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')

const LIMITS = {
  maxRouteStartTeeGapYds: 140,
  maxFairwayPolygons: 120,
  maxRoughPolygons: 160,
  maxBunkerPolygons: 120,
  maxPlayablePolygons: 400,
  maxRouteResidualYds: 100,
}

const promotedRouteCourses = [
  'tobacco-road',
  'arcadia-bluffs',
  'cabot-cliffs',
  'pebble-beach',
  'augusta-national',
  'oakmont-country-club',
  'erin-hills',
]

const spotlight = [
  { label: 'Greywolf H1', kind: 'greywolf' },
  { label: 'Tobacco Road H1', slug: 'tobacco-road', hole: 1 },
  { label: 'Erin Hills H1', slug: 'erin-hills', hole: 1 },
  { label: 'Oakmont H1', slug: 'oakmont-country-club', hole: 1 },
  { label: 'Cabot Cliffs H1', slug: 'cabot-cliffs', hole: 1 },
  { label: 'Pebble Beach H4', slug: 'pebble-beach', hole: 4 },
]

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'))

const holeFromManifest = (manifest, holeNumber) =>
  (manifest.holes ?? []).find((hole) => Number(hole.hole) === holeNumber) ?? null

const surfaceCount = (hole, kind) => Number(hole?.surfacePolygons?.[kind] ?? 0)
const playableCount = (hole) =>
  ['tee', 'fairway', 'rough', 'green', 'bunker', 'water']
    .reduce((total, kind) => total + surfaceCount(hole, kind), 0)

const issuesForHole = (hole) => {
  const issues = []
  if (!hole) return ['missing validation row']
  if (hole.ready === false) issues.push('validation says hole is not ready')
  if (hole.geometryPlausibility?.passed === false) issues.push('geometry plausibility failed')
  if (surfaceCount(hole, 'green') < 1) issues.push('no green polygon')
  if (hole.fairwayRequired && surfaceCount(hole, 'fairway') < 1) issues.push('no fairway polygon')

  const anchorMethod = String(hole.anchorMethod ?? '')
  const routeAnchored = anchorMethod === 'osm-hole-route-start'
  const selectedTeeAnchored = anchorMethod.startsWith('selected-tee')
  const teePolygons = surfaceCount(hole, 'tee')

  if (routeAnchored && teePolygons < 1) {
    issues.push('route-start package has no tee polygon to rebase to the selected-tee runtime contract')
  }
  if (selectedTeeAnchored && teePolygons < 1) {
    issues.push('selected-tee package has no selected tee polygon')
  }
  if (selectedTeeAnchored && hole.selectedTeeOsmId == null) {
    issues.push('selected-tee package has no selected tee OSM id')
  }

  // A large tee gap is a contract failure only while the route start itself is
  // pretending to be the runtime origin. V5 deliberately allows an OSM route
  // to begin inside the hole and records that gap while placing runtime [0,0]
  // on the evidence-selected mapped tee.
  const teeGap = Number(hole.nearestMappedTeeSurfaceYards)
  if (routeAnchored) {
    if (!Number.isFinite(teeGap)) {
      issues.push('route-start package has no mapped tee gap available')
    } else if (teeGap > LIMITS.maxRouteStartTeeGapYds) {
      issues.push(`nearest mapped tee is ${teeGap.toFixed(1)} yd from route origin`)
    }
  }

  const fairways = surfaceCount(hole, 'fairway')
  const rough = surfaceCount(hole, 'rough')
  const bunkers = surfaceCount(hole, 'bunker')
  const total = playableCount(hole)
  if (fairways > LIMITS.maxFairwayPolygons) {
    issues.push(`fairway fragmentation ${fairways} > ${LIMITS.maxFairwayPolygons}`)
  }
  if (rough > LIMITS.maxRoughPolygons) {
    issues.push(`rough fragmentation ${rough} > ${LIMITS.maxRoughPolygons}`)
  }
  if (bunkers > LIMITS.maxBunkerPolygons) {
    issues.push(`bunker fragmentation ${bunkers} > ${LIMITS.maxBunkerPolygons}`)
  }
  if (total > LIMITS.maxPlayablePolygons) {
    issues.push(`playable polygon count ${total} > ${LIMITS.maxPlayablePolygons}`)
  }

  const residual = Number(hole.routeLengthResidualYards)
  if (Number.isFinite(residual) && Math.abs(residual) > LIMITS.maxRouteResidualYds) {
    issues.push(`route/reference residual ${residual >= 0 ? '+' : ''}${residual.toFixed(1)} yd`)
  }

  return issues
}

const summaryForHole = (hole) => ({
  anchor: hole?.anchorMethod ?? 'unknown',
  teeGapYds: Number.isFinite(Number(hole?.nearestMappedTeeSurfaceYards))
    ? Number(hole.nearestMappedTeeSurfaceYards)
    : null,
  fairway: surfaceCount(hole, 'fairway'),
  rough: surfaceCount(hole, 'rough'),
  bunker: surfaceCount(hole, 'bunker'),
  green: surfaceCount(hole, 'green'),
  tee: surfaceCount(hole, 'tee'),
  totalPlayable: playableCount(hole),
  headingDegTrue: Number.isFinite(Number(hole?.headingDegreesTrue))
    ? Number(hole.headingDegreesTrue)
    : null,
})

const greywolfControl = () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'src/courseGeometry/greywolfCourseAdapter.ts'),
    'utf8',
  )
  const issues = []
  if (!source.includes("origin: 'selected-tee'")) issues.push('Greywolf no longer declares selected-tee origin')
  if (!source.includes("status: 'verified'")) issues.push('Greywolf registration is no longer verified')
  if (!source.includes('testedEndpoints: 40')) issues.push('Greywolf endpoint-validation fixture changed')
  return {
    summary: {
      anchor: 'selected-tee',
      teeGapYds: 0,
      fairway: 'proven package',
      rough: 'proven package',
      bunker: 'proven package',
      green: 'proven package',
      tee: 'proven package',
      totalPlayable: 'proven package',
      headingDegTrue: 'per-hole proven anchor',
    },
    issues,
  }
}

const manifestCache = new Map()
const manifestFor = (slug) => {
  if (manifestCache.has(slug)) return manifestCache.get(slug)
  const manifest = readJson(`artifacts/course-geometry/${slug}/validation-v1.json`)
  manifestCache.set(slug, manifest)
  return manifest
}

console.log('\nCourse runtime contract spotlight\n')
let spotlightFailures = 0
for (const target of spotlight) {
  if (target.kind === 'greywolf') {
    const control = greywolfControl()
    if (control.issues.length) spotlightFailures += control.issues.length
    console.log(`${target.label}:`, control.summary)
    for (const issue of control.issues) console.log(`  ERROR: ${issue}`)
    continue
  }

  const manifest = manifestFor(target.slug)
  const hole = holeFromManifest(manifest, target.hole)
  const issues = issuesForHole(hole)
  spotlightFailures += issues.length
  console.log(`${target.label}:`, summaryForHole(hole))
  for (const issue of issues) console.log(`  ERROR: ${issue}`)
}

console.log('\nPromoted automated-course sweep\n')
let sweepFailures = 0
let sweptHoles = 0
for (const slug of promotedRouteCourses) {
  const manifest = manifestFor(slug)
  const courseIssues = []
  for (const hole of manifest.holes ?? []) {
    sweptHoles += 1
    for (const issue of issuesForHole(hole)) {
      courseIssues.push(`H${hole.hole}: ${issue}`)
    }
  }
  if (courseIssues.length === 0) {
    console.log(`PASS ${manifest.courseName ?? slug}: ${manifest.holes?.length ?? 0} holes`)
  } else {
    sweepFailures += courseIssues.length
    console.log(`FAIL ${manifest.courseName ?? slug}: ${courseIssues.length} contract issue(s)`)
    for (const issue of courseIssues) console.log(`  ${issue}`)
  }
}

console.log(`\nAudited ${sweptHoles} promoted automated holes.`)
console.log(`Spotlight issues: ${spotlightFailures}; promoted-course issues: ${sweepFailures}.`)
console.log('Greywolf remains the golden control; automated packages must converge on its selected-tee/runtime-registration semantics.')

if (strict && (spotlightFailures > 0 || sweepFailures > 0)) {
  process.exitCode = 1
}
