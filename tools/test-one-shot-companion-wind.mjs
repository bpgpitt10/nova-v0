import assert from 'node:assert/strict'
import { createServer } from 'vite'

// This is the observed FarmLinks White H1 diagnostic, reduced to its HUD
// evidence. Note the last completed file record is stale Hole 4/Shot 5:
// that file must NOT suppress fresh on-screen wind/lie observations.
const nowMs = Date.parse('2026-10-13T11:03:24.000Z')
const observed = {
  service: 'looper-companion',
  status: 'ready',
  observedAt: '2026-10-13T11:03:17.614288Z',
  gspro: {status: 'connected', window: {minimized: false}},
  structured: {shot: {status: 'stale', holeNumber: 4, shotNumber: 5}},
  ocr: {
    wind: {
      status:'READY', speedMph:9, directionDegrees:135, convention:'from',
      referenceFrame:'compass', observedAt:'2026-10-13T11:03:20.398496Z',
      rawText:'SPEED: 9 MPH | DIR: SE',
    },
    lie: {
      status:'READY', upDownDegrees:0, leftRightDegrees:0,
      observedAt:'2026-10-13T11:03:21.604017Z',
      rawText:'0.0 UP 0.0 RIGHT',
    },
  },
}
const events = []
globalThis.window = { dispatchEvent: event => {events.push(event);return true} }
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init={}) {this.type=type;this.detail=init.detail}
}
const vite = await createServer({appType:'custom',logLevel:'silent',server:{middlewareMode:true}})
try {
  const {publishOneShotCompanionHud} = await vite.ssrLoadModule('/src/adapters/companionHudBridge.ts')
  const {GSPRO_WIND_OCR_BROWSER_EVENT, normalizeGsproWindOcrPayload} =
    await vite.ssrLoadModule('/src/adapters/gsproWindObservation.ts')
  const {GSPRO_LIE_OCR_BROWSER_EVENT} =
    await vite.ssrLoadModule('/src/adapters/gsproLieObservation.ts')
  const {projectWindObservation} = await vite.ssrLoadModule('/src/liveState/windProjection.ts')
  assert.deepEqual(publishOneShotCompanionHud(observed,nowMs),{wind:true,lie:true})
  assert.equal(events.length,2)
  assert.equal(events[0].type,GSPRO_WIND_OCR_BROWSER_EVENT)
  assert.equal(events[1].type,GSPRO_LIE_OCR_BROWSER_EVENT)
  const normalized=normalizeGsproWindOcrPayload(events[0].detail)
  assert.equal(normalized.status,'READY')
  assert.equal(normalized.speedMph,9)
  assert.equal(normalized.directionDegrees,135)
  const shotBearing=353.715216 // imported FarmLinks H1 heading from OSM
  const projected=projectWindObservation(normalized,0,shotBearing)
  assert.ok(projected.projection,'9mph SE must reach a modeled wind vector')
  assert.equal(events[1].detail.upDownDegrees,0)
  assert.equal(events[1].detail.leftRightDegrees,0)
  const testBad=(delta,when=nowMs)=>{
    const before=events.length
    assert.deepEqual(publishOneShotCompanionHud({...observed,...delta},when),{wind:false,lie:false})
    assert.equal(events.length,before)
  }
  testBad({observedAt:'2026-10-13T11:01:00Z'})
  testBad({gspro:{status:'connected',window:{minimized:true}}})
  testBad({gspro:{status:'waiting',window:{minimized:false}}})
  testBad({status:'unavailable'})
  const before=events.length
  assert.deepEqual(publishOneShotCompanionHud({
    ...observed,
    ocr:{...observed.ocr,wind:{...observed.ocr.wind,status:'UNKNOWN'}},
  },nowMs),{wind:false,lie:true})
  assert.equal(events.length,before+1)
  console.log('PASS: FarmLinks live single tee capture forwards 9 mph SE and 0/0 lie exactly once, no extra polling; stale/minimized/unready data refused.')
} finally {await vite.close()}
