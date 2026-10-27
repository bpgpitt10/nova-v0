import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'

// Simulate just browser events. No Windows Companion or repeated native reads.
const bus = new EventTarget()
globalThis.CustomEvent ??= class CustomEvent extends Event {
  constructor(type, init={}) { super(type); this.detail=init.detail }
}
globalThis.window = {
  addEventListener: (...args) => bus.addEventListener(...args),
  removeEventListener: (...args) => bus.removeEventListener(...args),
  dispatchEvent: event => bus.dispatchEvent(event),
  setInterval: () => 1,
  clearInterval: () => {},
}

const vite = await createServer({ appType:'custom', logLevel:'silent', server:{ middlewareMode:true } })
try {
  const { shotHudCaptureKey:key } = await vite.ssrLoadModule('/src/liveCaddie/shotHudCaptureKey.ts')
  const { publishOneShotCompanionHud:publish } =
    await vite.ssrLoadModule('/src/adapters/companionHudBridge.ts')
  const { connectToGsproWindObservation:windConnect } =
    await vite.ssrLoadModule('/src/adapters/gsproWindObservation.ts')
  const { connectToGsproLieObservation:lieConnect } =
    await vite.ssrLoadModule('/src/adapters/gsproLieObservation.ts')
  const { LIVE_CADDIE_SHOT_STATE_CHANGED_EVENT:SHOT_EVENT } =
    await vite.ssrLoadModule('/src/liveCaddie/roundRuntime.ts')

  const initial = { captureRoundId:'round-user-1',courseId:'farmlinks-pursell-farms-sylacauga-al',
    selectedHoleNumber:1,snapshotHoleNumber:1,nextShotNumber:1,
    latestShotKey:null,teePlacement:'provisional' }
  assert.equal(key(initial),null,'Initial provisional H1 tee uses separate one-shot calibration')
  const second = { ...initial,nextShotNumber:2,latestShotKey:'round-263:H1:S1',
    teePlacement:null }
  const secondKey=key(second)
  assert.ok(secondKey,'Physical shot 1 must trigger one new-shot HUD capture')
  assert.equal(key({...second}),secondKey,'Identical file snapshots must not recapture')
  assert.notEqual(key({...second,nextShotNumber:3,latestShotKey:'round-263:H1:S2'}),secondKey)
  assert.notEqual(key({...second,captureRoundId:'new-round'}),secondKey)
  assert.notEqual(key({...second,selectedHoleNumber:2,snapshotHoleNumber:2,nextShotNumber:1}),secondKey)
  assert.equal(key({...second,selectedHoleNumber:2,snapshotHoleNumber:1}),null,
    'Mismatched loaded/physical hole cannot read HUD')
  assert.equal(key({...second,latestShotKey:null}),null,
    'Must have actual physical GSPro shot key before new capture')
  assert.equal(key({...initial,selectedHoleNumber:2,snapshotHoleNumber:2,
    latestShotKey:'round-263:H1:S5',teePlacement:'mapped'} )!=null,true,
    'Later-hole first tee also gets a new wind/lie capture')

  let wind=null,lie=null
  const wc=windConnect({onObservation: x=>wind=x})
  const lc=lieConnect({onObservation: x=>lie=x})
  const now=new Date().toISOString()
  const obs=(speed,up)=>({
    status:'ready',observedAt:now,
    gspro:{status:'connected',window:{minimized:false}},
    ocr:{
      wind:{status:'READY',speedMph:speed,directionDegrees:315,
        convention:'from',referenceFrame:'compass',observedAt:now},
      lie:{status:'READY',upDownDegrees:up,leftRightDegrees:0,observedAt:now},
    },
  })
  assert.deepEqual(publish(obs(7,0)),{wind:true,lie:true})
  assert.equal(wind.status,'READY');assert.equal(wind.speedMph,7)
  assert.equal(lie.status,'READY');assert.equal(lie.upDownDegrees,0)

  window.dispatchEvent(new CustomEvent(SHOT_EVENT,{detail:{
    key:'round-263:H1:S1',nextShotNumber:2,holeNumber:1,source:'gspro',
  }}))
  assert.equal(wind.status,'STALE','Shot 2 invalidates Shot 1 wind')
  assert.equal(lie.status,'STALE','Shot 2 invalidates Shot 1 lie')
  assert.deepEqual(publish(obs(9,1.5)),{wind:true,lie:true})
  assert.equal(wind.status,'READY')
  assert.equal(wind.speedMph,9,'New-shot OCR must become the current wind')
  assert.equal(lie.status,'READY')
  assert.equal(lie.upDownDegrees,1.5,'New-shot OCR must become current lie')
  wc.disconnect();lc.disconnect()

  const page=readFileSync('src/pages/LiveCaddiePage.tsx','utf8')
  assert.ok(page.includes('postShotHudKey = shotHudCaptureKey('),
    'UI must derive physical shot key')
  assert.ok(page.includes('publishOneShotCompanionHud(obs)'),
    'Native one-shot HUD must reach the existing wind/lie adapters')
  assert.ok(page.includes('}, 1250)'),
    'Native HUD must capture after GSPro updates the post-shot screen')
  console.log('PASS: native wind/lie refreshed once per real physical shot, stale old shot rejected, Shot 2 wind+lie recommender events restored, no polling.')
} finally { await vite.close() }
