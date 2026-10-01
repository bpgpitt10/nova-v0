#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argValue = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`[course-import-contract] ${name} requires a value`)
  return value
}

const packageArg = argValue('--package')
const configArg = argValue('--config')
if (!packageArg || !configArg) {
  throw new Error('[course-import-contract] usage: node tools/validate-course-import-contract.mjs --package <course-v1.json> --config <build-config.json>')
}

const resolveInput = (value) => path.isAbsolute(value) ? value : path.resolve(repoRoot, value)
const readJson = (value) => JSON.parse(fs.readFileSync(resolveInput(value), 'utf8'))
const coursePackage = readJson(packageArg)
const config = readJson(configArg)

const fail = (message) => {
  throw new Error(`[course-import-contract] ${message}`)
}
const requireValue = (condition, message) => {
  if (!condition) fail(message)
}
const finitePoint = (value) =>
  Array.isArray(value)
  && value.length >= 2
  && Number.isFinite(value[0])
  && Number.isFinite(value[1])
const record = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null
const normalize = (value) => text(value)?.replace(/\s+/g, ' ').toLowerCase() ?? ''
const canonicalCandidateValues = (candidate) => [
  candidate.teeSet,
  ...(Array.isArray(candidate.teeAliases) ? candidate.teeAliases : []),
].map(normalize).filter(Boolean)

requireValue(config.schemaVersion === 'looper-course-build-config-v1', 'build config schema must be looper-course-build-config-v1')
requireValue(typeof config.courseId === 'string' && config.courseId.length > 0, 'build config courseId is required')
requireValue(typeof config.courseName === 'string' && config.courseName.length > 0, `${config.courseId}: build config courseName is required`)
requireValue(typeof config.location === 'string' && config.location.length > 0, `${config.courseId}: build config location is required`)
requireValue(typeof config.slug === 'string' && config.slug.length > 0, `${config.courseId}: build config slug is required`)

requireValue(coursePackage.schemaVersion === 'looper-static-course-package-v1', `${config.courseId}: package schema must be looper-static-course-package-v1`)
requireValue(coursePackage.courseId === config.courseId, `${config.courseId}: package courseId does not match build config`)
requireValue(coursePackage.courseName === config.courseName, `${config.courseId}: package courseName does not match build config`)
requireValue(coursePackage.holes && typeof coursePackage.holes === 'object' && !Array.isArray(coursePackage.holes), `${config.courseId}: package holes must be a keyed object`)

const holeNumbers = Object.keys(coursePackage.holes).map(Number).sort((a, b) => a - b)
requireValue(holeNumbers.length === 18, `${config.courseId}: package must contain exactly 18 holes`)
requireValue(holeNumbers.every((hole, index) => hole === index + 1), `${config.courseId}: package hole keys must be exactly 1-18`)

const hole1 = record(coursePackage.holes['1'])
const hole1Candidates = Array.isArray(hole1.teeCandidates) ? hole1.teeCandidates.map(record) : []
requireValue(hole1Candidates.length > 0, `${config.courseId} H1: no teeCandidates; course cannot enter Round Setup`)

// The explicit teeSetContract is the course-wide ordering authority. Candidate
// arrays are intentionally stored in physical/front-to-back order, so deriving
// the product tee-set order from candidate array order would be incorrect.
const hole1Contract = record(hole1.teeSetContract)
requireValue(hole1Contract.version === 1, `${config.courseId} H1: missing teeSetContract v1`)
requireValue(hole1Contract.sourceHole === 1, `${config.courseId} H1: teeSetContract must be sourced from Hole 1`)
const teeSets = Array.isArray(hole1Contract.teeSets)
  ? hole1Contract.teeSets.map(text).filter(Boolean)
  : []
requireValue(teeSets.length > 0, `${config.courseId} H1: teeSetContract exposes no canonical tee sets`)
const normalizedTeeSets = teeSets.map(normalize)
requireValue(new Set(normalizedTeeSets).size === normalizedTeeSets.length, `${config.courseId} H1: canonical teeSet values are not unique`)

const summaries = []
for (const holeNumber of holeNumbers) {
  const hole = record(coursePackage.holes[String(holeNumber)])
  const frame = record(hole.coordinateFrame)
  const surfaces = record(hole.surfaces)
  const candidates = Array.isArray(hole.teeCandidates) ? hole.teeCandidates.map(record) : []

  requireValue(frame.origin === 'selected-tee' || frame.origin === 'osm-hole-route-start', `${config.courseId} H${holeNumber}: unsupported coordinate-frame origin ${String(frame.origin)}`)
  requireValue(Array.isArray(surfaces.tee) && surfaces.tee.length > 0, `${config.courseId} H${holeNumber}: no tee surface geometry`)
  requireValue(Array.isArray(surfaces.green) && surfaces.green.length > 0, `${config.courseId} H${holeNumber}: no green surface geometry`)
  requireValue(candidates.length > 0, `${config.courseId} H${holeNumber}: no teeCandidates; course cannot enter the runtime/UI`)

  let selectedAnchors = 0
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    requireValue(finitePoint(candidate.coursePoint), `${config.courseId} H${holeNumber}: teeCandidate ${index + 1} has no finite coursePoint`)
    if (candidate.selectedAnchor === true) selectedAnchors += 1
    if (holeNumber === 1) {
      requireValue(Boolean(text(candidate.teeSet)), `${config.courseId} H1: teeCandidate ${index + 1} is missing its canonical teeSet`)
    }
  }
  requireValue(selectedAnchors === 1, `${config.courseId} H${holeNumber}: expected exactly one selectedAnchor teeCandidate, found ${selectedAnchors}`)

  // This is the core product invariant: every tee set Round Setup exposes from
  // the H1 contract must resolve to one and only one physical candidate on every
  // hole. A candidate may carry multiple aliases when several course-wide tee
  // sets share one physical box on a hole with fewer tee polygons.
  for (let teeIndex = 0; teeIndex < teeSets.length; teeIndex += 1) {
    const wanted = normalizedTeeSets[teeIndex]
    const matches = candidates.filter((candidate) => canonicalCandidateValues(candidate).includes(wanted))
    requireValue(
      matches.length === 1,
      `${config.courseId} H${holeNumber}: canonical tee set ${JSON.stringify(teeSets[teeIndex])} resolves to ${matches.length} candidates; expected exactly 1`,
    )
  }

  const contract = record(hole.teeSetContract)
  requireValue(contract.version === 1, `${config.courseId} H${holeNumber}: missing teeSetContract v1`)
  requireValue(contract.sourceHole === 1, `${config.courseId} H${holeNumber}: teeSetContract must be sourced from Hole 1`)
  const declaredSets = Array.isArray(contract.teeSets) ? contract.teeSets.map(normalize) : []
  requireValue(
    JSON.stringify(declaredSets) === JSON.stringify(normalizedTeeSets),
    `${config.courseId} H${holeNumber}: teeSetContract does not match the Hole 1 canonical tee-set ordering`,
  )

  summaries.push({
    hole: holeNumber,
    candidates: candidates.length,
    selectedAnchors,
    teeSetsResolved: teeSets.length,
  })
}

const aliases = Array.isArray(config.gsproAliases)
  ? [...new Set(config.gsproAliases.map(text).filter(Boolean))]
  : []
requireValue(aliases.length > 0, `${config.courseId}: gsproAliases must be declared in the build config so imported courses can resolve from GSPro without a hand edit`)

console.log(`[course-import-contract] ${config.courseId}: PASS — 18/18 holes satisfy the runtime geometry + tee-set contract.`)
console.log(`[course-import-contract] Round Setup exposes ${teeSets.length} canonical tee set(s): ${teeSets.join(', ')}.`)
console.log(`[course-import-contract] Every canonical tee set resolves exactly once on every hole; ${aliases.length} GSPro alias(es) declared.`)