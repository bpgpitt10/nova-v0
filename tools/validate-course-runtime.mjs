import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const originalFetch = globalThis.fetch
globalThis.window = globalThis

globalThis.fetch = async (input, init) => {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.pathname
      : input?.url

  if (typeof rawUrl === 'string' && rawUrl.startsWith('/course-geometry/')) {
    const filePath = resolve(process.cwd(), 'public', rawUrl.slice(1))
    try {
      const body = await readFile(filePath)
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }

  return originalFetch(input, init)
}

const assert = (condition, message) => {
  if (!condition) throw new Error(`[runtime-smoke] ${message}`)
}

const argValue = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`[runtime-smoke] ${name} requires a value`)
  return value
}

const requestedCourseId = argValue('--course')
const legacyCourses = [
  { name: 'Arcadia Bluffs', courseId: 'arcadia-bluffs-arcadia-mi' },
  { name: 'Cabot Cliffs', courseId: 'cabot-cliffs-inverness-ns' },
  { name: 'Pebble Beach', courseId: 'pebble-beach-pebble-beach-ca' },
  { name: 'Augusta National', courseId: 'augusta-national-augusta-ga' },
  { name: 'Oakmont', courseId: 'oakmont-country-club-oakmont-pa' },
  { name: 'Erin Hills', courseId: 'erin-hills-erin-wi' },
]

const normalize = (value) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').toLowerCase()
  : ''
const canonicalTeeValues = (candidate) => [
  candidate.teeSet,
  ...(candidate.teeAliases ?? []),
].map(normalize).filter(Boolean)

const server = await createServer({
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
})

try {
  const { loadCourseHoleGeometry } = await server.ssrLoadModule('/src/courseGeometry/courseProvider.ts')
  const { loadCourseTeeCandidates } = await server.ssrLoadModule('/src/courseGeometry/teeCandidateProvider.ts')
  const { getCourseCatalogEntry } = await server.ssrLoadModule('/src/courseGeometry/courseCatalog.ts')
  const { estimateGreywolfTerrain: estimateCourseTerrain } = await server.ssrLoadModule('/src/courseGeometry/lidar.ts')

  const courses = requestedCourseId
    ? [{ name: getCourseCatalogEntry(requestedCourseId).name, courseId: requestedCourseId }]
    : legacyCourses

  for (const { name, courseId } of courses) {
    const summaries = []
    const holeNumbers = requestedCourseId
      ? Array.from({ length: 18 }, (_, index) => index + 1)
      : [1, 9, 18]

    let canonicalTeeSets = []
    if (requestedCourseId) {
      const hole1Candidates = await loadCourseTeeCandidates(courseId, 1)
      assert(hole1Candidates.length > 0, `${name} returned zero usable Hole 1 tee candidates through the generic tee provider.`)
      canonicalTeeSets = hole1Candidates.map((candidate, index) => {
        assert(
          Array.isArray(candidate.coursePoint)
            && candidate.coursePoint.length >= 2
            && Number.isFinite(candidate.coursePoint[0])
            && Number.isFinite(candidate.coursePoint[1]),
          `${name} Hole 1 tee candidate ${index + 1} has an invalid runtime coursePoint.`,
        )
        assert(typeof candidate.teeSet === 'string' && candidate.teeSet.trim(), `${name} Hole 1 tee candidate ${index + 1} has no canonical teeSet.`)
        return candidate.teeSet.trim()
      })
      assert(
        new Set(canonicalTeeSets.map(normalize)).size === canonicalTeeSets.length,
        `${name} Hole 1 canonical teeSet values are not unique.`,
      )
    }

    for (const holeNumber of holeNumbers) {
      const hole = await loadCourseHoleGeometry(courseId, holeNumber)
      assert(hole.courseId === courseId, `${name} Hole ${holeNumber} course id mismatch.`)
      assert(hole.surfaces.length > 0, `${name} Hole ${holeNumber} has no playable surfaces.`)
      assert(hole.terrain, `${name} Hole ${holeNumber} did not expose CourseHoleGeometry.terrain.`)
      assert(hole.terrain.source === 'lidar-dem', `${name} Hole ${holeNumber} terrain source is not lidar-dem.`)
      assert(
        hole.terrain.values.length === hole.terrain.width * hole.terrain.height,
        `${name} Hole ${holeNumber} decoded terrain grid length mismatch.`,
      )

      if (requestedCourseId) {
        const candidates = hole.teeCandidates ?? []
        assert(candidates.length > 0, `${name} Hole ${holeNumber} lost teeCandidates before CourseHoleGeometry runtime.`)
        for (const teeSet of canonicalTeeSets) {
          const wanted = normalize(teeSet)
          const matches = candidates.filter((candidate) => canonicalTeeValues(candidate).includes(wanted))
          assert(
            matches.length === 1,
            `${name} Hole ${holeNumber} canonical tee ${JSON.stringify(teeSet)} resolved to ${matches.length} runtime candidates; expected exactly 1.`,
          )
        }
      }

      const tee = estimateCourseTerrain(hole, hole.markers.tee)
      assert(tee?.source === 'lidar-dem', `${name} Hole ${holeNumber} tee did not produce a direct DEM elevation sample.`)

      const targetPoint = hole.markers.pin ?? [0, Math.min(hole.bounds.maxY, 220)]
      const target = estimateCourseTerrain(hole, targetPoint)
      assert(target?.source === 'lidar-dem', `${name} Hole ${holeNumber} target did not produce a direct DEM elevation sample.`)

      const deltaFt = target.elevationFt - tee.elevationFt
      assert(Number.isFinite(deltaFt), `${name} Hole ${holeNumber} elevation delta was not finite.`)
      assert(
        Math.abs(deltaFt) < 1000,
        `${name} Hole ${holeNumber} elevation delta ${deltaFt.toFixed(1)} ft is implausible.`,
      )

      summaries.push({
        course: name,
        hole: holeNumber,
        surfaces: hole.surfaces.length,
        contextLayers: hole.contextLayers?.length ?? 0,
        teeCandidates: hole.teeCandidates?.length ?? 0,
        teeSetsResolved: requestedCourseId ? canonicalTeeSets.length : undefined,
        sourceResolutionMeters: hole.terrain.sourceResolutionMeters,
        runtimeSpacingYds: hole.terrain.runtimeSpacingYds,
        teeElevationFt: Number(tee.elevationFt.toFixed(1)),
        targetElevationFt: Number(target.elevationFt.toFixed(1)),
        elevationDeltaFt: Number(deltaFt.toFixed(1)),
      })
    }

    if (requestedCourseId) {
      console.log(`[runtime-smoke] ${name}: ${canonicalTeeSets.length} canonical Round Setup tee set(s) resolve exactly once through CourseHoleGeometry on all 18 holes: ${canonicalTeeSets.join(', ')}.`)
    }

    console.log(`[runtime-smoke] ${name} runtime terrain validation passed for ${holeNumbers.length} hole(s).`)
    console.table(summaries)
  }

  console.log(requestedCourseId
    ? `[runtime-smoke] ${requestedCourseId} passed the generic package + all-hole tee runtime path.`
    : '[runtime-smoke] All promoted automated course runtime validations passed.')
} finally {
  globalThis.fetch = originalFetch
  await server.close()
}