import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const packagePath = 'public/course-geometry/augusta-national/course-v1.json'
const loaderPath = 'src/courseGeometry/routePackagedCourseLoader.ts'

const course = JSON.parse(readFileSync(packagePath, 'utf8'))
const hole1 = course?.holes?.['1']

assert.equal(course?.courseId, 'augusta-national-augusta-ga')
assert.ok(hole1, 'Augusta Hole 1 must exist in the packaged course.')
assert.equal(hole1.par, 4, 'Augusta championship Hole 1 must remain a par 4.')
assert.ok(
  Number(hole1.referenceYards) > 400,
  `Augusta championship Hole 1 must remain >400 yd; got ${hole1.referenceYards}.`,
)
assert.ok(
  Array.isArray(hole1?.surfaces?.fairway) && hole1.surfaces.fairway.length > 0,
  'Augusta championship Hole 1 must retain fairway geometry.',
)
assert.equal(
  Array.isArray(hole1?.surfaces?.water) ? hole1.surfaces.water.length : 0,
  0,
  'Augusta championship Hole 1 should not regress to the pond-heavy Par 3 Course geometry.',
)
assert.ok(
  Array.isArray(hole1?.context?.woods) && hole1.context.woods.length > 0,
  'Augusta championship Hole 1 must retain woods context.',
)

// H1 terrain was deliberately removed when Augusta moved from the accidentally
// selected Par 3 family to the championship family.  During the focused rebuild
// it may be absent; once present it must be the new LiDAR/current-frame format.
if (hole1.terrain !== undefined) {
  assert.equal(hole1.terrain?.source, 'lidar-dem')
  assert.ok(Number(hole1.terrain?.sourceResolutionMeters) <= 1.1)
  assert.ok(Number(hole1.terrain?.runtimeSpacingYds) > 0)
  assert.ok(Number(hole1.terrain?.width) > 1)
  assert.ok(Number(hole1.terrain?.height) > 1)
  assert.equal(hole1.terrain?.compression, 'deflate')
  assert.ok(typeof hole1.terrain?.valuesBase64 === 'string' && hole1.terrain.valuesBase64.length > 0)
}

const loader = readFileSync(loaderPath, 'utf8')
assert.ok(
  loader.includes("cache: 'no-store'"),
  'Route course packages must bypass stale browser caches across deployments.',
)
assert.ok(
  !loader.includes("cache: 'force-cache'"),
  'Route course package loader must not force-cache deployment-stable package URLs.',
)

console.log('Augusta championship package + corrected-frame terrain guard: ok')
