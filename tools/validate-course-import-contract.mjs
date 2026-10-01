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

// This deliberately mirrors RoundSetupPage candidateTeeValues plus the generic
// tee loader's explicit fields. If the UI changes how a tee is identified, this
// contract should change in the same commit.
const candidateLabels = (candidate) => {
  const tags = record(candidate.sourceTags)
  const values = [
    candidate.teeSet,
    ...(Array.isArray(candidate.teeAliases) ? candidate.teeAliases : []),
    candidate.name,
    candidate.ref,
    candidate.color,
    candidate.label,
    tags.tee,
    tags.name,
    tags.ref,
    tags.colour,
    tags.color,
  ]
  return [...new Set(values.map(text).filter(Boolean))]
}

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

const summaries = []
for (const holeNumber of holeNumbers) {
  const hole = record(coursePackage.holes[String(holeNumber)])
  const frame = record(hole.coordinateFrame)
  const surfaces = record(hole.surfaces)
  const candidates = Array.isArray(hole.teeCandidates) ? hole.teeCandidates : []

  requireValue(frame.origin === 'selected-tee' || frame.origin === 'osm-hole-route-start', `${config.courseId} H${holeNumber}: unsupported coordinate-frame origin ${String(frame.origin)}`)
  requireValue(Array.isArray(surfaces.tee) && surfaces.tee.length > 0, `${config.courseId} H${holeNumber}: no tee surface geometry`)
  requireValue(Array.isArray(surfaces.green) && surfaces.green.length > 0, `${config.courseId} H${holeNumber}: no green surface geometry`)
  requireValue(candidates.length > 0, `${config.courseId} H${holeNumber}: no teeCandidates; course cannot enter the runtime/UI`)

  const labelOwners = new Map()
  let selectedAnchors = 0
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = record(candidates[index])
    requireValue(finitePoint(candidate.coursePoint), `${config.courseId} H${holeNumber}: teeCandidate ${index + 1} has no finite coursePoint`)
    if (candidate.selectedAnchor === true) selectedAnchors += 1
    for (const label of candidateLabels(candidate)) {
      const normalized = label.toLowerCase()
      const owners = labelOwners.get(normalized) ?? new Set()
      owners.add(index)
      labelOwners.set(normalized, owners)
    }
  }

  requireValue(selectedAnchors === 1, `${config.courseId} H${holeNumber}: expected exactly one selectedAnchor teeCandidate, found ${selectedAnchors}`)

  const uniqueLabels = [...labelOwners.entries()].filter(([, owners]) => owners.size === 1).map(([label]) => label)
  // Round Setup currently discovers the user's tee choices from Hole 1. Other
  // holes still need runtime candidates/anchors, but source OSM tagging can be
  // sparse away from H1 without making the geometry unusable.
  if (holeNumber === 1) {
    requireValue(uniqueLabels.length > 0, `${config.courseId} H1: no unambiguous tee label is available for Round Setup`)
  }

  summaries.push({
    hole: holeNumber,
    candidates: candidates.length,
    selectedAnchors,
    uniqueLabels: uniqueLabels.length,
  })
}

const aliases = Array.isArray(config.gsproAliases)
  ? [...new Set(config.gsproAliases.map(text).filter(Boolean))]
  : []
requireValue(aliases.length > 0, `${config.courseId}: gsproAliases must be declared in the build config so imported courses can resolve from GSPro without a hand edit`)

console.log(`[course-import-contract] ${config.courseId}: PASS — 18/18 holes have runtime tee candidates and required geometry.`)
console.log(`[course-import-contract] H1 exposes ${summaries[0].uniqueLabels} unambiguous tee label(s); ${aliases.length} GSPro alias(es) declared.`)
