import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const vite = await createServer({
  appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
})
try {
  const {
    firstTeeCaptureKey,
    isNewLooperRoundForCapture,
    captureStatusForKey,
    shouldHoldUnmatchedTeeRecommendation,
  } = await vite.ssrLoadModule('/src/liveCaddie/teeCaptureReadiness.ts')

  // Actual same-course restart scenario: both starts can see the *same*
  // previous GSPro RoundID and an identical 572-yard OSM back-tee snapshot.
  // Yet they are different user-initiated Looper rounds and need two captures.
  const course = 'farmlinks'
  const initial = firstTeeCaptureKey('looper-round-A', course, 1)
  const second = firstTeeCaptureKey('looper-round-B', course, 1)
  assert.notEqual(initial, second)
  assert.equal(isNewLooperRoundForCapture(null, 'looper-round-A'), true)
  assert.equal(isNewLooperRoundForCapture('looper-round-A', 'looper-round-A'), false)
  assert.equal(isNewLooperRoundForCapture('looper-round-A', 'looper-round-B'), true)
  assert.equal(isNewLooperRoundForCapture('looper-round-A', null), false)

  const seen = new Set()
  let active = null
  let captures = 0
  function onStart(id) {
    if (!isNewLooperRoundForCapture(active,id)) return
    active=id
    // Same reset done by the page and by browser GSPro snapshot dedup:
    seen.clear()
  }
  function capture() {
    const key=firstTeeCaptureKey(active,course,1)
    if (seen.has(key)) return
    seen.add(key)
    captures+=1
  }
  onStart('looper-round-A')
  capture()
  onStart('looper-round-A') // 3 repeated bootstrap emissions aren't new rounds
  onStart('looper-round-A')
  capture()
  assert.equal(captures,1)
  onStart('looper-round-B')
  capture()
  assert.equal(captures,2, 'same-course/new-round must read native HUD again')

  const provisional = {
    matchesCurrentHole:true, nextShotNumber:1,
    teePlacement:'provisional',
  }
  assert.equal(shouldHoldUnmatchedTeeRecommendation({
    ...provisional, calibrated:false, fallbackApproved:false,
  }),true,'Do not recommend from unmeasured 572yd back tee')
  assert.equal(shouldHoldUnmatchedTeeRecommendation({
    ...provisional, calibrated:true, fallbackApproved:false,
  }),false,'Measured 489-495yd tee enables recommendation')
  assert.equal(shouldHoldUnmatchedTeeRecommendation({
    ...provisional, calibrated:false, fallbackApproved:true,
  }),false,'Only explicit golfer fallback authorizes tentative advice')
  assert.equal(shouldHoldUnmatchedTeeRecommendation({
    ...provisional, nextShotNumber:2, calibrated:false,fallbackApproved:false,
  }),false,'Completed shot uses physical ball, not tee calibration')
  assert.equal(shouldHoldUnmatchedTeeRecommendation({
    ...provisional, teePlacement:'mapped', calibrated:false,fallbackApproved:false,
  }),false,'Mapped tee does not wait for optional OCR')
  assert.equal(captureStatusForKey({key:initial,status:'capturing'},second),'not-started')
  assert.equal(captureStatusForKey({key:second,status:'complete'},second),'complete')

  // Integration contract: a new Looper round must reset BOTH the React
  // one-shot capture and BrowserGsproCourseState's snapshot event dedupe.
  const page=readFileSync('src/pages/LiveCaddiePage.tsx','utf8')
  const state=readFileSync('src/adapters/browserGsproCourseState.ts','utf8')
  const landing=readFileSync('src/pages/LooperLandingPage.tsx','utf8')
  assert.ok(page.includes('LIVE_CADDIE_START_ROUND_EVENT'))
  assert.ok(page.includes('lastCaptureRoundIdRef.current = id'))
  assert.ok(page.includes('triedProvisionalTeeNative.current.clear()'))
  assert.ok(page.includes('setLiveSnapshot(null)'), 'new Looper round must not show previous shot while rearming')
  assert.ok(page.includes('[courseId, holeNumber, captureRoundId]'),
    'geometry cache/selected tee must reload for a second Looper round')
  assert.ok(page.includes('waitingForNewRoundSnapshot'),
    'do not rank against an old tee before new manual snapshot arrives')
  assert.ok(page.includes("status: 'capturing'"))
  assert.ok(page.includes('if (pending) triedProvisionalTeeNative.current.delete(key)'))
  assert.ok(page.includes('holdFirstTeeRecommendation'))
  assert.ok(page.includes('Use approximate OSM tee instead'))
  assert.ok(page.includes('Retry tee measurement'))
  assert.ok(state.includes('lastPublishedSnapshotSignature = null'))
  assert.ok(state.includes('lastPublishedShotStateKey = null'))
  assert.ok(state.includes('lastManuallyArmedLooperRoundId = armedRound.id'))
  assert.ok(landing.includes("onClick={() => navigateWithinApp('/round-setup')}"))
  assert.ok(!landing.includes('looper-landing-mode-card--caddie is-disabled'))
  console.log('PASS: homepage entry, unique Looper-round capture, duplicate bootstrap suppression, manual fallback gate, GSPro snapshot dedupe reset.')
} finally {
  await vite.close()
}
