#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifactRoot = path.join(repoRoot, 'artifacts/course-geometry')
const outputPath = path.join(repoRoot, 'src/courseGeometry/generatedImportedCourseRegistry.ts')

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'))
const receipts = fs.existsSync(artifactRoot)
  ? fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const receiptPath = path.join(artifactRoot, entry.name, 'runtime-ready-v1.json')
      if (!fs.existsSync(receiptPath)) return []
      return [{ slug: entry.name, receipt: readJson(receiptPath), receiptPath }]
    })
  : []

const fail = (message) => { throw new Error(`[course-registry] ${message}`) }
const quote = (value) => JSON.stringify(value)
const ids = new Set()
const slugs = new Set()
const entries = []

for (const { slug, receipt, receiptPath } of receipts) {
  if (receipt.schemaVersion !== 'looper-course-runtime-ready-v1') fail(`${slug}: invalid runtime-ready receipt schema`)
  if (receipt.runtimeReady !== true) fail(`${slug}: receipt exists but runtimeReady is not true`)
  if (receipt.slug !== slug) fail(`${slug}: receipt slug mismatch`)
  if (typeof receipt.courseId !== 'string' || !receipt.courseId) fail(`${slug}: missing courseId`)
  if (typeof receipt.courseName !== 'string' || !receipt.courseName) fail(`${slug}: missing courseName`)
  if (typeof receipt.location !== 'string' || !receipt.location) fail(`${slug}: missing location`)
  if (!Array.isArray(receipt.gsproAliases) || receipt.gsproAliases.length === 0) fail(`${slug}: missing gsproAliases`)
  if (ids.has(receipt.courseId)) fail(`${slug}: duplicate courseId ${receipt.courseId}`)
  if (slugs.has(slug)) fail(`${slug}: duplicate slug`)
  ids.add(receipt.courseId)
  slugs.add(slug)

  const packagePath = path.join(repoRoot, 'public/course-geometry', slug, 'course-v1.json')
  if (!fs.existsSync(packagePath)) fail(`${slug}: receipt exists but runtime package is missing`)
  if (typeof receipt.packageSha256 !== 'string' || receipt.packageSha256.length !== 64) fail(`${slug}: receipt packageSha256 is missing`)

  entries.push({
    id: receipt.courseId,
    name: receipt.courseName,
    location: receipt.location,
    slug,
    gsproAliases: [...new Set(receipt.gsproAliases.map((value) => String(value).trim()).filter(Boolean))],
    staticPackageUrl: `/course-geometry/${slug}/course-v1.json`,
    status: 'validated',
    packageStatus: 'ready',
    packageVersion: 'v1',
    packageCacheStatus: 'cached',
    osmCacheStatus: 'cached',
    lidarCacheStatus: receipt.terrainReady === true ? 'cached' : 'unknown',
    receiptPath: path.relative(repoRoot, receiptPath).replaceAll('\\', '/'),
  })
}

entries.sort((a, b) => a.name.localeCompare(b.name))
const lines = [
  '// GENERATED FILE. Do not hand-edit.',
  '// Source of truth: artifacts/course-geometry/*/runtime-ready-v1.json',
  '// A course appears here only after the canonical importer passes the static',
  '// import contract and the generic runtime loader/tee smoke test.',
  '',
  'export const generatedImportedCourseRegistry = [',
]

for (const entry of entries) {
  lines.push('  {')
  lines.push(`    id: ${quote(entry.id)},`)
  lines.push(`    name: ${quote(entry.name)},`)
  lines.push(`    location: ${quote(entry.location)},`)
  lines.push(`    slug: ${quote(entry.slug)},`)
  lines.push(`    gsproAliases: ${JSON.stringify(entry.gsproAliases)},`)
  lines.push(`    staticPackageUrl: ${quote(entry.staticPackageUrl)},`)
  lines.push("    status: 'validated',")
  lines.push("    packageStatus: 'ready',")
  lines.push("    packageVersion: 'v1',")
  lines.push("    packageCacheStatus: 'cached',")
  lines.push("    osmCacheStatus: 'cached',")
  lines.push(`    lidarCacheStatus: ${quote(entry.lidarCacheStatus)},`)
  lines.push('  },')
}
lines.push('] as const')
lines.push('')

const next = lines.join('\n')
const previous = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null
if (previous !== next) fs.writeFileSync(outputPath, next, 'utf8')
console.log(`[course-registry] generated ${entries.length} canonical imported course registration(s).`)
