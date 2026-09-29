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

const courses = [
  {
    name: 'Arcadia Bluffs',
    courseId: 'arcadia-bluffs-arcadia-mi',
  },
  {
    name: 'Cabot Cliffs',
    courseId: 'cabot-cliffs-inverness-ns',
  },
  {
    name: 'Pebble Beach',
    courseId: 'pebble-beach-pebble-beach-ca',
  },
  {
    name: 'Augusta National',
    courseId: 'augusta-national-augusta-ga',
  },
  {
    name: 'Oakmont',
    courseId: 'oakmont-country-club-oakmont-pa',
  },
  {
    name: 'Erin Hills',
    courseId: 'erin-hills-erin-wi',
  },
]

const server = await createServer({
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
})

try {
  const { loadCourseHoleGeometry } = await server.ssrLoadModule('/src/courseGeometry/courseProvider.ts')
  const { estimateGreywolfTerrain: estimateCourseTerrain } = await server.ssrLoadModule('/src/courseGeometry/lidar.ts')

  for (const { name, courseId } of courses) {
    const summaries = []

    for (const holeNumber of [1, 9, 18]) {
      const hole = await loadCourseHoleGeometry(courseId, holeNumber)
      assert(hole.courseId === courseId, `${name} Hole ${holeNumber} course id mismatch.`)
      assert(hole.surfaces.length > 0, `${name} Hole ${holeNumber} has no playable surfaces.`)
      assert(hole.terrain, `${name} Hole ${holeNumber} did not expose CourseHoleGeometry.terrain.`)
      assert(hole.terrain.source === 'lidar-dem', `${name} Hole ${holeNumber} terrain source is not lidar-dem.`)
      assert(
        hole.terrain.values.length === hole.terrain.width * hole.terrain.height,
        `${name} Hole ${holeNumber} decoded terrain grid length mismatch.`,
      )

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
        sourceResolutionMeters: hole.terrain.sourceResolutionMeters,
        runtimeSpacingYds: hole.terrain.runtimeSpacingYds,
        teeElevationFt: Number(tee.elevationFt.toFixed(1)),
        targetElevationFt: Number(target.elevationFt.toFixed(1)),
        elevationDeltaFt: Number(deltaFt.toFixed(1)),
      })
    }

    console.log(`[runtime-smoke] ${name} runtime terrain validation passed.`)
    console.table(summaries)
  }

  console.log('[runtime-smoke] All promoted automated course runtime validations passed.')
} finally {
  globalThis.fetch = originalFetch
  await server.close()
}
