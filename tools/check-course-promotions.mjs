import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const readText = (path) => readFileSync(new URL(path, root), 'utf8')
const readJson = (path) => JSON.parse(readText(path))
const fail = (message) => {
  throw new Error(`[course-promotion] ${message}`)
}
const requireValue = (condition, message) => {
  if (!condition) fail(message)
}
const sha256 = (path) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')
const fileExists = (path) => existsSync(new URL(path, root))

const catalogSource = readText('src/courseGeometry/courseCatalog.ts')
const artifactRoot = new URL('artifacts/course-geometry/', root)
const supportedBuilders = new Set([
  'build_osm_course_package_v3',
  'build_osm_course_package_v5',
])

const promoted = readdirSync(artifactRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const slug = entry.name
    const cachePath = `artifacts/course-geometry/${slug}/cache-v1.json`
    if (!fileExists(cachePath)) return null

    const cache = readJson(cachePath)
    if (!supportedBuilders.has(cache.package?.builderVersion)) return null

    const packagePath = cache.package?.path
    const configPath = cache.package?.configPath
    const validationPath = `artifacts/course-geometry/${slug}/validation-v1.json`
    const completePromotion =
      typeof packagePath === 'string' &&
      typeof configPath === 'string' &&
      fileExists(packagePath) &&
      fileExists(configPath) &&
      fileExists(validationPath)

    if (!completePromotion) {
      console.warn(`[course-promotion] ${cache.courseId ?? slug}: cached build is incomplete; leaving it unpromoted`)
      return null
    }

    return { slug, cachePath, cache }
  })
  .filter(Boolean)
  .sort((a, b) => a.slug.localeCompare(b.slug))

requireValue(promoted.length > 0, 'no promoted automated course packages were discovered')

const seenCourseIds = new Set()
const seenPackagePaths = new Set()

for (const promotedCourse of promoted) {
  const { slug, cache } = promotedCourse
  const courseId = cache.courseId
  const packagePath = cache.package?.path
  const configPath = cache.package?.configPath
  const builderVersion = cache.package?.builderVersion
  const validationPath = `artifacts/course-geometry/${slug}/validation-v1.json`
  const staticPackageUrl = `/course-geometry/${slug}/course-v1.json`

  requireValue(typeof courseId === 'string' && courseId.length > 0, `${slug}: cache metadata courseId is required`)
  requireValue(!seenCourseIds.has(courseId), `${courseId}: duplicate course id among promoted packages`)
  requireValue(typeof packagePath === 'string' && packagePath.length > 0, `${courseId}: cached package path is required`)
  requireValue(!seenPackagePaths.has(packagePath), `${courseId}: duplicate package path among promoted packages`)
  requireValue(supportedBuilders.has(builderVersion), `${courseId}: unsupported automated package builder ${builderVersion}`)
  seenCourseIds.add(courseId)
  seenPackagePaths.add(packagePath)

  requireValue(packagePath === `public/course-geometry/${slug}/course-v1.json`, `${courseId}: package path does not match promoted slug`)
  requireValue(typeof configPath === 'string' && configPath.length > 0, `${courseId}: cached config path is required`)
  requireValue(fileExists(configPath), `${courseId}: promoted build config is missing at ${configPath}`)
  requireValue(fileExists(validationPath), `${courseId}: promoted geometry validation is missing at ${validationPath}`)
  requireValue(fileExists(packagePath), `${courseId}: promoted runtime package is missing at ${packagePath}`)

  const config = readJson(configPath)
  const validation = readJson(validationPath)
  const coursePackage = readJson(packagePath)

  requireValue(config.courseId === courseId, `${courseId}: build config courseId does not match`)
  requireValue(config.slug === slug, `${courseId}: build config slug does not match promoted directory`)
  requireValue(validation.courseId === courseId, `${courseId}: validation courseId does not match`)
  requireValue(validation.compiler === builderVersion, `${courseId}: validation compiler does not match cache builder ${builderVersion}`)
  requireValue(validation.allHolesStaticGeometryReady === true, `${courseId}: validation does not mark all holes ready`)
  requireValue(Array.isArray(validation.holes) && validation.holes.length === 18, `${courseId}: validation must contain 18 holes`)
  requireValue(validation.holes.every((hole) => hole?.ready === true), `${courseId}: at least one validation hole is not ready`)

  const validationHoleNumbers = validation.holes.map((hole) => hole?.hole).sort((a, b) => a - b)
  requireValue(validationHoleNumbers.every((hole, index) => hole === index + 1), `${courseId}: validation hole numbers are not exactly 1-18`)

  requireValue(cache.schemaVersion === 'looper-course-cache-v1', `${courseId}: cache metadata schema is invalid`)
  requireValue(cache.package?.schemaVersion === 'looper-static-course-package-v1', `${courseId}: cached package schema is invalid`)
  requireValue(cache.package?.path === packagePath, `${courseId}: cache metadata points at a different package path`)
  requireValue(cache.package?.configPath === configPath, `${courseId}: cache metadata points at a different config path`)
  requireValue(cache.source?.provider === 'openstreetmap-overpass', `${courseId}: OSM source provenance is missing or unexpected`)
  requireValue(typeof cache.source?.snapshotSha256 === 'string' && cache.source.snapshotSha256.length === 64, `${courseId}: source snapshot hash is missing`)

  if (builderVersion === 'build_osm_course_package_v5') {
    const snapshotPath = cache.source?.snapshotPath
    requireValue(typeof snapshotPath === 'string' && snapshotPath.length > 0, `${courseId}: V5 source snapshot path is missing`)
    requireValue(fileExists(snapshotPath), `${courseId}: V5 source snapshot is not preserved at ${snapshotPath}`)
    requireValue(sha256(snapshotPath) === cache.source.snapshotSha256, `${courseId}: V5 source snapshot SHA-256 does not match cache metadata`)
    requireValue(typeof validation.builderFingerprintSha256 === 'string' && validation.builderFingerprintSha256.length === 64, `${courseId}: V5 validation builder fingerprint is missing`)
    requireValue(validation.builderFingerprintSha256 === cache.package?.builderFingerprintSha256, `${courseId}: V5 validation/cache builder fingerprints do not match`)
  }

  const actualPackageSha = sha256(packagePath)
  requireValue(cache.package?.sha256 === actualPackageSha, `${courseId}: package SHA-256 does not match cache metadata`)

  requireValue(coursePackage.schemaVersion === 'looper-static-course-package-v1', `${courseId}: runtime package schema is invalid`)
  requireValue(coursePackage.courseId === courseId, `${courseId}: runtime package courseId does not match`)
  requireValue(
    coursePackage.holes && typeof coursePackage.holes === 'object' && !Array.isArray(coursePackage.holes),
    `${courseId}: runtime package holes must use the canonical keyed-hole object`,
  )
  const packageHoleNumbers = Object.keys(coursePackage.holes).map(Number).sort((a, b) => a - b)
  requireValue(packageHoleNumbers.length === 18, `${courseId}: runtime package must contain 18 holes`)
  requireValue(packageHoleNumbers.every((hole, index) => hole === index + 1), `${courseId}: runtime package hole keys are not exactly 1-18`)
  requireValue(
    packageHoleNumbers.every((holeNumber) => {
      const packagedHoleNumber = coursePackage.holes[String(holeNumber)]?.holeNumber
      return packagedHoleNumber == null || packagedHoleNumber === holeNumber
    }),
    `${courseId}: one or more present runtime holeNumber values do not match their package keys`,
  )

  if (cache.terrain?.status === 'cached') {
    requireValue(
      typeof cache.terrain?.terrainPackageSha256 === 'string' && cache.terrain.terrainPackageSha256.length === 64,
      `${courseId}: cached terrain package hash is missing`,
    )
    requireValue(coursePackage.terrainProvenance, `${courseId}: cached terrain is not represented in the runtime package`)
  }

  const idNeedle = `id: '${courseId}'`
  const catalogStart = catalogSource.indexOf(idNeedle)
  requireValue(catalogStart >= 0, `${courseId}: course is missing from the runtime registry`)
  const catalogEnd = catalogSource.indexOf('\n  },', catalogStart)
  requireValue(catalogEnd > catalogStart, `${courseId}: could not isolate runtime catalog entry`)
  const catalogEntry = catalogSource.slice(catalogStart, catalogEnd)
  requireValue(catalogEntry.includes(`slug: '${slug}'`), `${courseId}: runtime slug does not match promoted directory`)
  requireValue(catalogEntry.includes(`staticPackageUrl: '${staticPackageUrl}'`), `${courseId}: runtime staticPackageUrl does not match promoted package`)
  requireValue(catalogEntry.includes("status: 'validation'"), `${courseId}: runtime status must remain validation until visual acceptance`)
  requireValue(catalogEntry.includes("packageStatus: 'validation'"), `${courseId}: runtime packageStatus must remain validation until visual acceptance`)
  requireValue(catalogEntry.includes("packageVersion: 'v1'"), `${courseId}: runtime packageVersion must be v1`)
  requireValue(catalogEntry.includes("packageCacheStatus: 'cached'"), `${courseId}: runtime package cache must be marked cached`)
  requireValue(catalogEntry.includes("osmCacheStatus: 'cached'"), `${courseId}: runtime OSM cache must be marked cached`)

  const catalogMarksLidarCached = catalogEntry.includes("lidarCacheStatus: 'cached'")
  const catalogMarksLidarUnknown = catalogEntry.includes("lidarCacheStatus: 'unknown'")
  requireValue(catalogMarksLidarCached || catalogMarksLidarUnknown, `${courseId}: runtime LiDAR cache status must be cached or unknown`)
  if (catalogMarksLidarCached) {
    requireValue(cache.terrain?.status === 'cached', `${courseId}: runtime catalog claims cached LiDAR without cached terrain metadata`)
  }

  const warningCount = validation.holes.reduce(
    (total, hole) => total + (Array.isArray(hole?.warnings) ? hole.warnings.length : 0),
    0,
  )
  console.log(`[course-promotion] ${courseId}: PASS (${builderVersion}, 18/18 ready, ${warningCount} validation warnings, ${actualPackageSha.slice(0, 12)}…)`)
}

console.log(`[course-promotion] ${promoted.length} promoted automated course packages passed structural/cache/runtime gates.`)
