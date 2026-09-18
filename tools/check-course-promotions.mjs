import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

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

const manifest = readJson('config/course-promotions-v1.json')
requireValue(manifest.schemaVersion === 'looper-course-promotions-v1', 'promotion manifest schema is invalid')
requireValue(Array.isArray(manifest.courses) && manifest.courses.length > 0, 'promotion manifest has no courses')

const catalogSource = readText('src/courseGeometry/courseCatalog.ts')
const seenCourseIds = new Set()
const seenPackagePaths = new Set()

for (const promoted of manifest.courses) {
  const {
    courseId,
    slug,
    status,
    staticPackageUrl,
    packagePath,
    configPath,
    validationPath,
    cachePath,
  } = promoted

  requireValue(typeof courseId === 'string' && courseId.length > 0, 'courseId is required')
  requireValue(typeof slug === 'string' && slug.length > 0, `${courseId}: slug is required`)
  requireValue(status === 'validation', `${courseId}: automated promotion must remain in validation status`)
  requireValue(!seenCourseIds.has(courseId), `${courseId}: duplicate course id in promotion manifest`)
  requireValue(!seenPackagePaths.has(packagePath), `${courseId}: duplicate package path in promotion manifest`)
  seenCourseIds.add(courseId)
  seenPackagePaths.add(packagePath)

  const config = readJson(configPath)
  const validation = readJson(validationPath)
  const cache = readJson(cachePath)
  const coursePackage = readJson(packagePath)

  requireValue(config.courseId === courseId, `${courseId}: build config courseId does not match`)
  requireValue(validation.courseId === courseId, `${courseId}: validation courseId does not match`)
  requireValue(validation.compiler === 'build_osm_course_package_v3', `${courseId}: validation was not produced by the topology-safe V3 compiler`)
  requireValue(validation.allHolesStaticGeometryReady === true, `${courseId}: validation does not mark all holes ready`)
  requireValue(Array.isArray(validation.holes) && validation.holes.length === 18, `${courseId}: validation must contain 18 holes`)
  requireValue(validation.holes.every((hole) => hole?.ready === true), `${courseId}: at least one validation hole is not ready`)

  const validationHoleNumbers = validation.holes.map((hole) => hole?.hole).sort((a, b) => a - b)
  requireValue(validationHoleNumbers.every((hole, index) => hole === index + 1), `${courseId}: validation hole numbers are not exactly 1-18`)

  requireValue(cache.schemaVersion === 'looper-course-cache-v1', `${courseId}: cache metadata schema is invalid`)
  requireValue(cache.courseId === courseId, `${courseId}: cache metadata courseId does not match`)
  requireValue(cache.package?.schemaVersion === 'looper-static-course-package-v1', `${courseId}: cached package schema is invalid`)
  requireValue(cache.package?.builderVersion === 'build_osm_course_package_v3', `${courseId}: cache metadata was not built by V3`)
  requireValue(cache.package?.path === packagePath, `${courseId}: cache metadata points at a different package path`)
  requireValue(cache.package?.configPath === configPath, `${courseId}: cache metadata points at a different config path`)
  requireValue(cache.source?.provider === 'openstreetmap-overpass', `${courseId}: OSM source provenance is missing or unexpected`)
  requireValue(typeof cache.source?.snapshotSha256 === 'string' && cache.source.snapshotSha256.length === 64, `${courseId}: source snapshot hash is missing`)

  const actualPackageSha = sha256(packagePath)
  requireValue(cache.package?.sha256 === actualPackageSha, `${courseId}: package SHA-256 does not match cache metadata`)

  requireValue(coursePackage.schemaVersion === 'looper-static-course-package-v1', `${courseId}: runtime package schema is invalid`)
  requireValue(coursePackage.courseId === courseId, `${courseId}: runtime package courseId does not match`)
  requireValue(Array.isArray(coursePackage.holes) && coursePackage.holes.length === 18, `${courseId}: runtime package must contain 18 holes`)

  const packageHoleNumbers = coursePackage.holes.map((hole) => hole?.holeNumber).sort((a, b) => a - b)
  requireValue(packageHoleNumbers.every((hole, index) => hole === index + 1), `${courseId}: runtime package hole numbers are not exactly 1-18`)

  const idNeedle = `id: '${courseId}'`
  const catalogStart = catalogSource.indexOf(idNeedle)
  requireValue(catalogStart >= 0, `${courseId}: course is missing from the runtime registry`)
  const catalogEnd = catalogSource.indexOf('\n  },', catalogStart)
  requireValue(catalogEnd > catalogStart, `${courseId}: could not isolate runtime catalog entry`)
  const catalogEntry = catalogSource.slice(catalogStart, catalogEnd)
  requireValue(catalogEntry.includes(`staticPackageUrl: '${staticPackageUrl}'`), `${courseId}: runtime staticPackageUrl does not match promotion manifest`)
  requireValue(catalogEntry.includes("status: 'validation'"), `${courseId}: runtime status must remain validation until visual acceptance`)
  requireValue(catalogEntry.includes("packageStatus: 'validation'"), `${courseId}: runtime packageStatus must remain validation until visual acceptance`)
  requireValue(catalogEntry.includes("packageVersion: 'v1'"), `${courseId}: runtime packageVersion must be v1`)
  requireValue(catalogEntry.includes("packageCacheStatus: 'cached'"), `${courseId}: runtime package cache must be marked cached`)
  requireValue(catalogEntry.includes("osmCacheStatus: 'cached'"), `${courseId}: runtime OSM cache must be marked cached`)
  requireValue(catalogEntry.includes("lidarCacheStatus: 'unknown'"), `${courseId}: LiDAR must not be claimed until generalized LiDAR ingestion is proven`)

  const warningCount = validation.holes.reduce(
    (total, hole) => total + (Array.isArray(hole?.warnings) ? hole.warnings.length : 0),
    0,
  )
  console.log(`[course-promotion] ${courseId}: PASS (18/18 ready, ${warningCount} validation warnings, ${actualPackageSha.slice(0, 12)}…)`)
}

console.log(`[course-promotion] ${manifest.courses.length} promoted course packages passed structural/cache/runtime gates.`)
