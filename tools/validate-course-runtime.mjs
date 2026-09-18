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

const server = await createServer({
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
})

try {
  const arcadiaPackage = JSON.parse(
    await readFile(
      resolve(process.cwd(), 'public/course-geometry/arcadia-bluffs/course-v1.json'),
      'utf-8',
    ),
  )
  const rawHole1 = arcadiaPackage?.holes?.['1']
  console.log('[runtime-smoke] Arcadia Hole 1 raw contract', JSON.stringify({
    keys: rawHole1 && typeof rawHole1 === 'object' ? Object.keys(rawHole1) : null,
    bounds: rawHole1?.bounds ?? null,
    viewBounds: rawHole1?.viewBounds ?? null,
    coordinateSystem: rawHole1?.coordinateSystem ?? null,
    coordinateFrame: rawHole1?.coordinateFrame ?? null,
  }))

  const { loadCourseHoleGeometry } = await server.ssrLoadModule('/src/courseGeometry/courseProvider.ts')
  const { estimateGreywolfTerrain: estimateCourseTerrain } = await server.ssrLoadModule('/src/courseGeometry/lidar.ts')

  const courseId = 'arcadia-bluffs-arcadia-mi'
  const summaries = []

  for (const holeNumber of [1, 9, 18]) {
    const hole = await loadCourseHoleGeometry(courseId, holeNumber)
    assert(hole.courseId === courseId, `Hole ${holeNumber} course id mismatch.`)
    assert(hole.surfaces.length > 0, `Hole ${holeNumber} has no playable surfaces.`)
    assert(hole.terrain, `Hole ${holeNumber} did not expose CourseHoleGeometry.terrain.`)
    assert(hole.terrain.source === 'lidar-dem', `Hole ${holeNumber} terrain source is not lidar-dem.`)
    assert(
      hole.terrain.values.length === hole.terrain.width * hole.terrain.height,
      `Hole ${holeNumber} decoded terrain grid length mismatch.`,
    )

    const tee = estimateCourseTerrain(hole, hole.markers.tee)
    assert(tee?.source === 'lidar-dem', `Hole ${holeNumber} tee did not produce a direct DEM elevation sample.`)

    const targetPoint = hole.markers.pin ?? [0, Math.min(hole.bounds.maxY, 220)]
    const target = estimateCourseTerrain(hole, targetPoint)
    assert(target?.source === 'lidar-dem', `Hole ${holeNumber} target did not produce a direct DEM elevation sample.`)

    const deltaFt = target.elevationFt - tee.elevationFt
    assert(Number.isFinite(deltaFt), `Hole ${holeNumber} elevation delta was not finite.`)
    assert(Math.abs(deltaFt) < 1000, `Hole ${holeNumber} elevation delta ${deltaFt.toFixed(1)} ft is implausible.`)

    summaries.push({
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

  console.log('[runtime-smoke] Arcadia runtime terrain validation passed.')
  console.table(summaries)
} finally {
  globalThis.fetch = originalFetch
  await server.close()
}
