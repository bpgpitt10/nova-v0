import assert from 'node:assert/strict'
import { createServer } from 'vite'

const memory = new Map()
globalThis.window = {
  localStorage: {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key),
  },
  dispatchEvent: () => true,
}
globalThis.CustomEvent ??= class CustomEvent {
  constructor(type, opts={}) { this.type=type;this.detail=opts.detail }
}
const vite = await createServer({
  appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
})
try {
  const { estimateProvisionalTee:estimate, readTeeBallPinDistanceYds:measure } =
    await vite.ssrLoadModule('/src/courseGeometry/provisionalTeeEstimate.ts')
  const { resolveLiveSupportedTee:resolve } =
    await vite.ssrLoadModule('/src/courseGeometry/liveSupportedTee.ts')
  const { startLiveCaddieRound:start } =
    await vite.ssrLoadModule('/src/liveCaddie/roundRuntime.ts')
  const { lockTeeCalibration:lock } =
    await vite.ssrLoadModule('/src/courseGeometry/teeCalibrationStore.ts')
  const { courseGeometryFingerprint:fingerprint } =
    await vite.ssrLoadModule('/src/courseGeometry/shotOneTeeResolver.ts')

  const geom = {
    schemaVersion:'looper-course-geometry-v1',courseId:'farmlinks',
    courseName:'Fixture imported course',holeNumber:1,par:4,
    coordinateSystem:{units:'yards',origin:'osm-hole-route-start',xAxis:'right',yAxis:'forward'},
    markers:{tee:[0,0],pin:[0,400]},
    surfaces:[],teeCandidates:[],
    availability:{tee:'unavailable',fairway:'available',rough:'available',
      'deep-rough':'unavailable',green:'available',bunker:'partial',water:'partial',penalty:'partial'},
    registration:{status:'approximate',targetCoordinateSystem:'looper-hole-local-yards'},
    provenance:{geometrySource:'fixture',sourceBaseTimestamp:'2026-10-12'},
    bounds:{minX:-85,maxX:85,minY:-80,maxY:460},
  }
  const initial=estimate(geom)
  assert.equal(initial.status,'provisional')
  assert.deepEqual(initial.point,[0,0])
  assert.equal(initial.uncertaintyRadiusYds,50)
  assert.equal(initial.usableForExactHazardCarry,false)
  assert.equal(initial.authorizesNativeAim,false)
  assert.equal(initial.locksTeeCalibration,false)
  const adjusted=estimate(geom,425)
  assert.equal(adjusted.status,'provisional')
  assert.ok(Math.abs(adjusted.point[0])<1e-9)
  assert.equal(adjusted.point[1],-25)
  assert.equal(adjusted.uncertaintyRadiusYds,25)
  assert.equal(adjusted.adjustmentYds,-25)
  assert.equal(estimate(geom,490).status,'blocked')
  assert.equal(estimate({...geom,coordinateSystem:{
    ...geom.coordinateSystem,origin:'selected-tee',
  }},425).status,'blocked')
  assert.equal(estimate({...geom,markers:{tee:[0,0]}},425).status,'blocked')
  assert.equal(estimate({...geom,registration:{
    status:'unavailable',targetCoordinateSystem:'looper-hole-local-yards',
  }},425).status,'blocked')

  const scale=measure({
    markerStatus:'markers_found',ballPixel:{x:100,y:700},pinPixel:{x:100,y:100},
    yardsPerPixel:2/3,scaleStatus:'provisional_gray_waypoint',waypointCount:4,
  })
  assert.ok(Math.abs(scale-400)<1e-6)
  assert.equal(measure({
    markerStatus:'markers_found',ballPixel:{x:100,y:700},pinPixel:{x:100,y:100},
    yardsPerPixel:2/3,scaleStatus:'provisional_gray_waypoint',waypointCount:1,
  }),null)
  assert.equal(measure({
    markerStatus:'markers_found',ballPixel:{x:100,y:700},pinPixel:{x:100,y:100},
    yardsPerPixel:2/3,scaleStatus:'provisional_world_distance',waypointCount:4,
  }),null)
  assert.equal(measure({
    markerStatus:'markers_unavailable',ballPixel:{x:100,y:700},pinPixel:{x:100,y:100},
    yardsPerPixel:2/3,scaleStatus:'provisional_gray_waypoint',waypointCount:4,
  }),null)

  const started = start({courseId:'farmlinks',teeSet:'Blue'})
  assert.ok(started)
  const live=resolve(geom,null)
  assert.equal(live.status,'supported')
  assert.equal(live.placement,'provisional')
  assert.deepEqual(live.courseLocalYds,[0,0])
  assert.equal(live.uncertaintyRadiusYds,50)
  const observed=resolve(geom,{
    holeNumber:1,shotNumber:1,surface:'tee',distanceToPinYds:425,
  })
  assert.equal(observed.status,'supported')
  assert.equal(observed.placement,'provisional')
  assert.deepEqual(observed.courseLocalYds,[0,-25])
  const onFairway=resolve(geom,{
    holeNumber:1,shotNumber:2,surface:'fairway',distanceToPinYds:425,
  })
  assert.deepEqual(onFairway.courseLocalYds,[0,0])
  const bad=resolve(geom,{holeNumber:1,shotNumber:1,surface:'tee',distanceToPinYds:490})
  assert.equal(bad.status,'unsupported')
  const mapped=resolve({
    ...geom,coordinateSystem:{...geom.coordinateSystem,origin:'selected-tee'},
    teeCandidates:[{osmId:'1',teeSet:'Blue',coursePoint:[12,-18],teeToGreenCentroidYards:419}],
    markers:{tee:[0,0],pin:[0,400]},
  },null)
  assert.equal(mapped.status,'supported')
  assert.equal(mapped.placement,'mapped')
  assert.deepEqual(mapped.courseLocalYds,[12,-18])

  const locked=lock({
    courseFingerprint:fingerprint(geom),holeNumber:1,teeSet:'Blue',
    courseLocalYds:[9,-33],confidence:.98,confirmationMethod:'physically-validated',
  })
  assert.equal(locked.outcome,'saved')
  const afterLock=resolve(geom,null)
  assert.equal(afterLock.status,'supported')
  assert.equal(afterLock.placement,'locked')
  assert.deepEqual(afterLock.courseLocalYds,[9,-33])
  assert.equal(afterLock.uncertaintyRadiusYds,null)
  console.log('PASS: first-use shot 1 provisional fallback, GSPro ruler refinement, 45yd mismatch rejection, no map/tee overriding, locked > provisional and fail-closed safety.')
} finally { await vite.close() }
