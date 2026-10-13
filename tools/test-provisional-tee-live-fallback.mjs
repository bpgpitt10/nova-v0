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
  const broad=estimate(geom,490)
  assert.equal(broad.status,'provisional')
  assert.deepEqual(broad.point,[0,-90])
  assert.ok(broad.uncertaintyRadiusYds>=50)
  assert.equal(estimate(geom,600).status,'blocked')
  const normalizedButUnmatched=estimate({...geom,coordinateSystem:{
    ...geom.coordinateSystem,origin:'selected-tee',
  }},425)
  assert.equal(normalizedButUnmatched.status,'provisional')
  assert.equal(normalizedButUnmatched.adjustmentYds,-25)
  assert.equal(estimate({...geom,coordinateSystem:{
    ...geom.coordinateSystem,origin:'selected-tee',
  },registration:{
    status:'verified',targetCoordinateSystem:'looper-hole-local-yards',
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
  assert.equal(bad.status,'supported')
  assert.equal(bad.placement,'provisional')
  assert.deepEqual(bad.courseLocalYds,[0,-90])
  assert.ok(bad.uncertaintyRadiusYds>=50)
  // Actual FarmLinks White H1: GSPro ~493 yd; five OSM tee polygons, Tee 3
  // ~495 yd to green center. Do not relabel the user's White tee as Tee 3.
  const farmlinks={...geom,markers:{tee:[0,0],pin:[0,572]},
    teeCandidates:[
      {teeSet:'Tee 1 (Back)',osmId:101,coursePoint:[0,0],teeToGreenCentroidYards:572},
      {teeSet:'Tee 2',osmId:102,coursePoint:[0,26],teeToGreenCentroidYards:546},
      {teeSet:'Tee 3',osmId:103,coursePoint:[-37,78],teeToGreenCentroidYards:495},
      {teeSet:'Tee 4',osmId:104,coursePoint:[-20,136],teeToGreenCentroidYards:436},
      {teeSet:'Tee 5 (Front)',osmId:105,coursePoint:[-36,156],teeToGreenCentroidYards:417},
    ],
  }
  start({courseId:'farmlinks',teeSet:'White'})
  const white=resolve(farmlinks,{
    holeNumber:1,shotNumber:1,surface:'tee',distanceToPinYds:493,
  })
  assert.equal(white.status,'supported')
  assert.equal(white.placement,'provisional')
  assert.equal(white.candidate?.teeSet,'Tee 3')
  assert.deepEqual(white.courseLocalYds,[-37,78])
  assert.ok(white.reason.includes('White'))
  assert.ok(white.reason.includes('not confirmed'))
  assert.equal(white.uncertaintyRadiusYds,25)
  const manual=resolve(farmlinks,null)
  assert.equal(manual.placement,'provisional')
  assert.deepEqual(manual.courseLocalYds,[0,0]) // no verified ruler yet
  const ambiguous=resolve({...farmlinks,teeCandidates:[
    ...farmlinks.teeCandidates,
    {teeSet:'Tee X',osmId:999,coursePoint:[25,85],teeToGreenCentroidYards:496},
  ]},{holeNumber:1,shotNumber:1,surface:'tee',distanceToPinYds:493})
  assert.equal(ambiguous.placement,'provisional')
  assert.equal(ambiguous.candidate,null) // distance match refused
  assert.ok(ambiguous.uncertaintyRadiusYds>=50)
  // Reset active selection for the original mapped/locked tests below.
  start({courseId:'farmlinks',teeSet:'Blue'})
  const approximateSelectedTee=resolve({
    ...geom,coordinateSystem:{...geom.coordinateSystem,origin:'selected-tee'},
  },null)
  assert.equal(approximateSelectedTee.status,'supported')
  assert.equal(approximateSelectedTee.placement,'provisional')
  assert.equal(approximateSelectedTee.uncertaintyRadiusYds,50)
  const verifiedSelectedTee=resolve({
    ...geom,coordinateSystem:{...geom.coordinateSystem,origin:'selected-tee'},
    registration:{status:'verified',targetCoordinateSystem:'looper-hole-local-yards'},
  },null)
  assert.equal(verifiedSelectedTee.status,'supported')
  assert.equal(verifiedSelectedTee.placement,'mapped')
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
  console.log('PASS: first-use fallback, FarmLinks White provisional Tee 3 distance match, ambiguous tee rejection, wide route fallback, locked tee precedence.')
} finally { await vite.close() }
