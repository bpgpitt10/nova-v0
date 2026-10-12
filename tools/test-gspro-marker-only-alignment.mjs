import assert from 'node:assert/strict'
import { createServer } from 'vite'
const vite = await createServer({ appType:'custom', logLevel:'silent',server:{middlewareMode:true} })
try {
  const { evaluateMarkerOnlyCourseAlignment:evaluate } =
    await vite.ssrLoadModule('/src/courseGeometry/gsproMarkerOnlyAlignment.ts')
  const current = '2026-10-12T15:00:00.000Z', nowMs = Date.parse(current)
  const polygon = (...pts) => pts
  const surface = (kind, polygons) => ({
    id: kind, kind, polygons, provenance:{source:'osm',confidence:'high'},
  })
  const geometry = {
    holeNumber:8, courseId:'greywolf-panorama-bc',
    markers:{tee:[0,0],pin:[0,300]},
    surfaces:[
      surface('rough',[polygon([-80,-30],[80,-30],[80,325],[-80,325])]),
      surface('fairway',[polygon([24,90],[45,90],[45,210],[24,210])]),
      surface('green',[polygon([-15,283],[15,283],[15,317],[-15,317])]),
    ],
  }
  const base = {
    service:'looper-companion',stateAuthority:'diagnostic-only',
    capabilities:{autoAim:false},status:'ready',observedAt:current,
    gspro:{status:'connected',window:{minimized:false,dpiAwareness:'per-monitor'}},
    structured:{shot:{status:'ready',kind:'pre_shot',holeNumber:8,shotNumber:1}},
    minimap:{status:'markers_found',ballPixel:{x:100,y:800},pinPixel:{x:100,y:200},
      scale:{status:'provisional_gray_waypoint',yardsPerPixel:.5},
      waypointRuler:{status:'scale_candidate',candidates:[
        {pixel:{x:170,y:500},yards:154.03,ocrVotes:7,confidence:.91},
      ]}},
  }
  const opts={selectedCourseKeyMatches:true,visuallyConfirmedCourseAndHole:true,nowMs}
  const result=evaluate(geometry,base,opts)
  assert.equal(result.status,'approximate-research-only')
  assert.equal(result.identityStatus,'matching-pre-shot')
  assert.equal(result.verifiedForPlay,false)
  assert.equal(result.authorizesNativeAim,false)
  assert.equal(result.canPublishCourse,false)
  assert.ok(result.waypointRulerErrorPercent < .05)
  assert.equal(result.teePinLengthDifferenceYds,0)
  assert.equal(result.alternatives.length,2)
  const near=result.alternatives.find(x=>x.handedness==='screen-right-to-course-right')
  const mirrored=result.alternatives.find(x=>x.handedness==='mirrored')
  assert.equal(near.fairwayDistanceYds,0)
  assert.ok(mirrored.fairwayDistanceYds >= 55)
  assert.deepEqual(near.mapPoint,[35,150])
  assert.deepEqual(mirrored.mapPoint,[-35,150])
  // A mirror ambiguity is explicitly retained and not chosen from one
  // noisy feature or a known-bad OSM hazard reconstruction.
  const old={...base,structured:{shot:{...base.structured.shot,kind:'last_completed',
    status:'completed_record_only',holeNumber:7}}}
  const manual=evaluate(geometry,old,opts)
  assert.equal(manual.status,'approximate-research-only')
  assert.equal(manual.identityStatus,'manual-hole-only')
  assert.equal(manual.verifiedForPlay,false)
  for(const bad of [
    evaluate(geometry,base,{...opts,selectedCourseKeyMatches:false}),
    evaluate(geometry,base,{...opts,visuallyConfirmedCourseAndHole:false}),
    evaluate(geometry,{...base,observedAt:'2026-10-12T14:45:00.000Z'},opts),
    evaluate(geometry,{...base,minimap:{...base.minimap,pinPixel:null}},opts),
    evaluate(geometry,{...base,minimap:{...base.minimap,waypointRuler:{candidates:[]}}},opts),
    evaluate(geometry,{...base,minimap:{...base.minimap,
      scale:{status:'provisional_gray_waypoint',yardsPerPixel:.7}}},opts),
    evaluate({...geometry,markers:{tee:[0,0],pin:undefined}},base,opts),
  ]) {
    assert.equal(bad.status,'blocked',bad.reason)
    assert.equal(bad.alternatives.length,0)
    assert.equal(bad.authorizesNativeAim,false)
  }
  console.log('PASS: GSPro ball + gray waypoint + pin; OSM axis approximation, mirror alternatives, dogleg waypoint, missing landmarks, no playable/aim trust')
} finally {
  await vite.close()
}
