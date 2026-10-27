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
  const page=readFileSync('src/pages/LiveCaddiePage.tsx','utf8')
  assert.ok(page.includes('postShotHudKey = shotHudCaptureKey('),
    'UI must derive physical shot key')
  assert.ok(page.includes('publishOneShotCompanionHud(obs)'),
    'Native one-shot HUD must reach the existing wind/lie adapters')
  assert.ok(page.includes('void capture(0) }, 1250)'),
    'Native HUD must capture after GSPro updates the post-shot screen')
  assert.ok(page.includes('const MAX_CAPTURE_ATTEMPTS = 2')
    && page.includes('attempt + 1 < MAX_CAPTURE_ATTEMPTS')
    && page.includes('void capture(attempt + 1) }, 1750)'),
    'At most one retry for partial/noisy captures, not open-ended polling')
  assert.ok(page.includes('const result = publishOneShotCompanionHud(obs)')
    && page.includes('complete = result.wind && result.lie'),
    'Only complete shot-scoped wind/lie OCR is terminal success')
  assert.ok(!page.slice(page.indexOf('const postShotHudKey = shotHudCaptureKey('),
      page.indexOf('// The ball and pin plus a native waypoint scale'))
    .includes('document.hidden'), 'GSPro foreground must not disable background-browser shot HUD reads')

  window.dispatchEvent(new CustomEvent(SHOT_EVENT,{detail:{
    key:'round-263:H1:S2',nextShotNumber:3,holeNumber:1,source:'gspro',
  }}))
  assert.equal(wind.status,'STALE');assert.equal(lie.status,'STALE')
  const partial=obs(8,2)
  partial.ocr.lie.status='UNAVAILABLE'
  assert.deepEqual(publish(partial),{wind:true,lie:false},'Incomplete lie must request one bounded retry')
  assert.equal(wind.status,'READY');assert.equal(lie.status,'STALE')
  assert.deepEqual(publish(obs(8,2)),{wind:true,lie:true},
    'Retry repairs missing lie without requiring manual toggle')
  assert.equal(lie.status,'READY');assert.equal(lie.upDownDegrees,2)

  wc.disconnect();lc.disconnect()
  console.log('PASS: post-shot wind/lie refresh after canonical shot, missed lie recovered via bounded retry, no manual toggle/polling; browser background does not gate readings.')
} finally { await vite.close() }
