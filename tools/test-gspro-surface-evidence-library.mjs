import assert from 'node:assert/strict'
import { createServer } from 'vite'
const db=new Map()
globalThis.window={localStorage:{
  getItem:k=>db.get(k)??null,
  setItem:(k,v)=>db.set(k,String(v)),
}}
const server=await createServer({appType:'custom',logLevel:'silent',server:{middlewareMode:true}})
try {
  const {GSProSurfaceCodeEvidenceLibrary,gsproSurfaceCodeEvidence,surfaceFromGsproRaw}=
    await server.ssrLoadModule('/src/adapters/gsproSurfaceCodes.ts')
  const {loadGsproSurfaceEvidenceSamples,recordGsproSurfaceHudConfirmation}=
    await server.ssrLoadModule('/src/adapters/gsproSurfaceEvidenceStore.ts')
  const expected=['rough','fairway',null,'green',null,'tee']
  assert.deepEqual(GSProSurfaceCodeEvidenceLibrary.map(x=>x.operationalLabel),expected)
  assert.equal(gsproSurfaceCodeEvidence(3).state,'blocked-unverified')
  assert.equal(gsproSurfaceCodeEvidence(11).state,'blocked-unverified')
  assert.equal(surfaceFromGsproRaw(3),null)
  assert.equal(surfaceFromGsproRaw(11),null)
  assert.equal(surfaceFromGsproRaw(18),'tee')
  assert.equal(surfaceFromGsproRaw(9),null)
  assert.equal(loadGsproSurfaceEvidenceSamples().length,0)
  const sample={shotKey:'farmlinks-H1-255-shot2',shotId:'52ac565c-test',
    courseId:'farmlinks',holeNumber:1,roundId:255,
    completedHoleShot:1,endingSurfaceRaw:3,gsproHudLabel:'deep-rough',
    observedAt:'2026-10-13T11:12:17Z',
    source:'golfer-confirmed-visible-gspro-hud'}
  assert.equal(recordGsproSurfaceHudConfirmation(sample),true)
  assert.deepEqual(loadGsproSurfaceEvidenceSamples(),[sample])
  assert.equal(recordGsproSurfaceHudConfirmation({...sample,gsproHudLabel:'rough'}),true)
  assert.equal(loadGsproSurfaceEvidenceSamples().length,1,
    'correction to same physical shot replaces old pair')
  assert.equal(loadGsproSurfaceEvidenceSamples()[0].gsproHudLabel,'rough')
  // Recording a paired observation does not accidentally approve an unverified code.
  assert.equal(surfaceFromGsproRaw(3),null)
  assert.equal(recordGsproSurfaceHudConfirmation({...sample,endingSurfaceRaw:-1}),false)
  assert.equal(loadGsproSurfaceEvidenceSamples().length,1)
  console.log('PASS: evidence inventory and local paired lie samples never silently promote unsupported numeric code to sand/deep rough.')
} finally {await server.close()}
