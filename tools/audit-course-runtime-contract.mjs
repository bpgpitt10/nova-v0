#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')
const candidateIndex = process.argv.indexOf('--candidate')
const candidateSlug = candidateIndex >= 0 ? process.argv[candidateIndex + 1] : null
if (candidateIndex >= 0 && !candidateSlug) {
  throw new Error('[course-runtime-audit] --candidate requires a course slug')
}

const LIMITS = {
  maxRouteStartTeeGapYds: 140,
  maxFairwayPolygons: 120,
  maxRoughPolygons: 160,
  maxBunkerPolygons: 120,
  maxPlayablePolygons: 400,
  maxRouteResidualYds: 100,
}

const catalogSource = fs.readFileSync(
  path.join(repoRoot, 'src/courseGeometry/courseCatalog.ts'),
  'utf8',
)

const registeredRouteCourses = [
  ...catalogSource.matchAll(/staticPackageUrl: '\/course-geometry\/([^']+)\/course-v1\.json'/g),
].map((match) => match[1])

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'))

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
  return { issues }
}

const manifestCache = new Map()
const manifestFor = (slug) => {
  if (manifestCache.has(slug)) return manifestCache.get(slug)
  const manifest = readJson(`artifacts/course-geometry/${slug}/validation-v1.json`)
  manifestCache.set(slug, manifest)
  return manifest
}

const auditManifest = (slug) => {
  const manifest = manifestFor(slug)
  const issues = []
  for (const hole of manifest.holes ?? []) {
    for (const issue of issuesForHole(hole)) {
      issues.push(`H${hole.hole}: ${issue}`)
    }
  }
  return { manifest, issues }
}

console.log('\nCourse runtime contract controls\n')
const greywolf = greywolfControl()
console.log(`Greywolf golden control: ${greywolf.issues.length === 0 ? 'PASS' : 'FAIL'}`)
for (const issue of greywolf.issues) console.log(`  ERROR: ${issue}`)

// Accepted runtime courses have already passed visual/playability acceptance.
// Keep heuristic fragmentation checks visible as baseline diagnostics, but do
// not retroactively fail them when those heuristics are stricter than proven packages.
console.log('\nAccepted runtime baseline (informational)\n')
let acceptedWarnings = 0
for (const slug of registeredRouteCourses) {
  const { manifest, issues } = auditManifest(slug)
  acceptedWarnings += issues.length
  if (issues.length === 0) {
    console.log(`PASS ${manifest.courseName ?? slug}: ${manifest.holes?.length ?? 0} holes`)
  } else {
    console.log(`WARN ${manifest.courseName ?? slug}: ${issues.length} heuristic issue(s) in accepted baseline`)
    for (const issue of issues) console.log(`  ${issue}`)
  }
}

let candidateFailures = 0
if (candidateSlug) {
  console.log('\nRebuild candidate strict audit\n')
  const { manifest, issues } = auditManifest(candidateSlug)
  candidateFailures = issues.length
  const h1 = (manifest.holes ?? []).find((hole) => Number(hole.hole) === 1) ?? null
  console.log(`${candidateSlug} H1:`, summaryForHole(h1))
  if (issues.length === 0) {
    console.log(`PASS ${manifest.courseName ?? candidateSlug}: ${manifest.holes?.length ?? 0} holes`)
  } else {
    console.log(`FAIL ${manifest.courseName ?? candidateSlug}: ${issues.length} contract issue(s)`)
    for (const issue of issues) console.log(`  ${issue}`)
  }
}

console.log(`\nGreywolf control issues: ${greywolf.issues.length}; accepted baseline warnings: ${acceptedWarnings}; candidate issues: ${candidateFailures}.`)
console.log('Accepted-course heuristic warnings are informational; Greywolf regressions and rebuild-candidate issues are blocking.')

if (strict && (greywolf.issues.length > 0 || candidateFailures > 0)) {
  process.exitCode = 1
}
