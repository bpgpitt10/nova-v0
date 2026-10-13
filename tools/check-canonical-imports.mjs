#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifactRoot = path.join(root, 'artifacts/course-geometry')
const generatedPath = path.join(root, 'src/courseGeometry/generatedImportedCourseRegistry.ts')
const generatedSource = existsSync(generatedPath) ? readFileSync(generatedPath, 'utf8') : ''
const sha256 = (filePath) => createHash('sha256').update(readFileSync(filePath)).digest('hex')
const fail = (message) => { throw new Error(`[canonical-import-ci] ${message}`) }

const receiptPaths = existsSync(artifactRoot)
  ? readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(artifactRoot, entry.name, 'runtime-ready-v1.json'))
    .filter(existsSync)
  : []

let readyCount = 0
for (const receiptPath of receiptPaths) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  if (receipt.schemaVersion !== 'looper-course-runtime-ready-v1') fail(`${receiptPath}: invalid receipt schema`)
  if (receipt.runtimeReady !== true) fail(`${receipt.courseId ?? receiptPath}: checked-in receipt is not runtimeReady`)
  if (receipt.staticReady !== true) fail(`${receipt.courseId}: receipt is not staticReady`)

  const slug = receipt.slug
  const packagePath = path.join(root, 'public/course-geometry', slug, 'course-v1.json')
  const manifestPath = path.join(root, 'artifacts/course-geometry', slug, 'validation-v1.json')
  const configPath = path.resolve(root, receipt.configPath)
  if (!existsSync(packagePath)) fail(`${receipt.courseId}: runtime package missing`)
  if (!existsSync(manifestPath)) fail(`${receipt.courseId}: validation manifest missing`)
  if (!existsSync(configPath)) fail(`${receipt.courseId}: build config missing`)
  if (sha256(packagePath) !== receipt.packageSha256) fail(`${receipt.courseId}: receipt package hash is stale`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.canonicalImport?.complete !== true || manifest.canonicalImport?.runtimeReady !== true) {
    fail(`${receipt.courseId}: validation manifest is not stamped complete/runtimeReady`)
  }
  if (manifest.canonicalImport?.packageSha256 !== receipt.packageSha256) {
    fail(`${receipt.courseId}: validation manifest package hash does not match runtime-ready receipt`)
  }

  const idNeedle = `id: '${receipt.courseId}'`
  const slugNeedle = `slug: '${slug}'`
  const urlNeedle = `staticPackageUrl: '/course-geometry/${slug}/course-v1.json'`
  if (!generatedSource.includes(idNeedle) || !generatedSource.includes(slugNeedle) || !generatedSource.includes(urlNeedle)) {
    fail(`${receipt.courseId}: generated runtime registry is stale or missing this successful import`)
  }

  const contract = spawnSync(
    process.execPath,
    [
      path.join(root, 'tools/validate-course-import-contract.mjs'),
      '--package', packagePath,
      '--config', configPath,
    ],
    { cwd: root, encoding: 'utf8' },
  )
  if (contract.status !== 0) {
    process.stdout.write(contract.stdout ?? '')
    process.stderr.write(contract.stderr ?? '')
    fail(`${receipt.courseId}: static runtime import contract failed in CI`)
  }

  readyCount += 1
  console.log(`[canonical-import-ci] ${receipt.courseId}: PASS (${receipt.packageSha256.slice(0, 12)}…)`)
}

console.log(`[canonical-import-ci] ${readyCount} generated canonical import(s) passed receipt, registry, hash, and runtime-package contract gates.`)
