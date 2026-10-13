import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const vite = await createServer({appType:'custom', logLevel:'silent', server:{middlewareMode:true}})
try {
  const {buildUnderRangeShotStrategy} = await vite.ssrLoadModule('/src/liveCaddie/shotStrategy.ts')
  const {closestPointOnHazardEdge,buildShotStrategyTacticalRead} = await vite.ssrLoadModule('/src/liveCaddie/shotStrategyTerrain.ts')
  const {greywolfHole01Geometry} = await vite.ssrLoadModule('/src/courseGeometry/greywolfHole01.ts')
  const {clubEligibleForShot} = await vite.ssrLoadModule('/src/liveCaddie/clubShotEligibility.ts')

  const polygon = [[-100,0],[100,0],[100,8],[-100,8]]
  const nearLongEdge = closestPointOnHazardEdge([0,-1], polygon)
  assert.ok(nearLongEdge)
  assert.ok(Math.abs(nearLongEdge.distanceYds-1)<1e-6,
    'long bunker edge one yard away must be detected even with vertices >100yd away')
  const inside = closestPointOnHazardEdge([0,4], polygon)
  assert.equal(inside.distanceYds,0,'inside hazard should not show no hazard')
  const farAway = closestPointOnHazardEdge([0,-75], polygon)
  assert.ok(farAway.distanceYds>28)
  const syntheticHole = {
    ...greywolfHole01Geometry,
    surfaces:[{id:'bunker-long-edge',kind:'bunker',polygons:[polygon]}],
  }
  const tactical = buildShotStrategyTacticalRead(syntheticHole,[0,-62],[0,-1],null)
  assert.match(tactical.hazard,/Bunker/i)
  assert.ok(tactical.safeMiss)

  const ball=[0,0]
  const evaluation = {
    club:'LW', variant:'stock', supportShots:12,
    stockCarryYds:90,modeledCarryYds:88,
    lateralBiasYds:1,modeledLateralBiasYds:2.4,
    windCarryDeltaYds:-1,windLateralDeltaYds:0.2,
    surfaceCarryDeltaYds:-2, surfaceLateralDeltaYds:0.4,
  }
  const shot = distanceYds => buildUnderRangeShotStrategy({
    evaluations:[evaluation],
    hole:greywolfHole01Geometry,
    ball,
    target:[0,distanceYds],
    pin:[0,distanceYds+5],
    greenDetail:null,
    trustedPin:false,
  })
  for(const distance of [5,60,75]){
    const s=shot(distance)
    assert.ok(s,'a '+distance+' yd chip/pitch under calibrated 88yd minimum should use Shot Strategy')
    assert.equal(s.referenceEvaluation.club,'LW')
    assert.deepEqual(s.target,[0,distance],
      'map target and playing-distance baseline MUST share the same coordinate')
    assert.equal(s.targetDistanceYds,distance)
    assert.equal(s.adjustmentScale,distance/90)
    assert.ok(Math.abs(s.effectiveDistanceYds-(distance+2*(distance/90)))<1e-8)
    assert.equal(s.effectiveLateralChangeYds,1.4*(distance/90))
  }
  assert.equal(shot(88),null,'at modeled floor, full shot ranking returns')
  assert.equal(shot(95),null,'above floor, full shot ranking returns')
  assert.equal(buildUnderRangeShotStrategy({
    evaluations:[{...evaluation,supportShots:0}],
    hole:greywolfHole01Geometry,ball,target:[0,60],pin:[0,60],greenDetail:null,
  }),null,'do not infer uncalibrated reference flight')

  assert.equal(clubEligibleForShot('Driver','non-tee'),false)
  assert.equal(clubEligibleForShot('Mini Driver','non-tee'),false)
  assert.equal(clubEligibleForShot('LW','non-tee'),true)
  const page=readFileSync('src/pages/LiveCaddiePage.tsx','utf8')
  const worker=readFileSync('src/pages/LiveCaddieWorker.ts','utf8')
  const panel=readFileSync('src/pages/ConditionsMathPanel.tsx','utf8')
  assert.ok(page.includes('buildUnderRangeShotStrategy'))
  assert.ok(page.includes('trustedPin: Boolean(trustedLivePin'),
    'only explicitly validated GSPro pin can enable precise green-LiDAR strategy')
  assert.ok(page.includes('club: isShotStrategy ? null : displayedClub'),
    'partial strategic target must NEVER authorize native club aim')
  assert.ok(page.includes('targetLocalYds: isShotStrategy ? null'),
    'partial strategic target must NEVER authorize native pixel aim')
  assert.ok(page.includes('const risk = isShotStrategy ? null'),
    'full swing dispersion cannot be used for partial shots')
  assert.ok(page.includes('{!isShotStrategy ? <article className="live-outcomes-card">'),
    'no invented full-shot success/confidence box in partial mode')
  assert.ok(page.includes(') : isGreenSurface ? ('),
    'caddie stays paused on greens')
  assert.ok(page.includes('holdFirstTeeRecommendation'),
    'partial strategy must not bypass first-tee readiness gate')
  assert.ok(panel.includes('strategyAdjustmentScale'))
  assert.ok(panel.includes('SHOT REQUIREMENT'))
  assert.ok(worker.includes('shortestSupportedModeledCarryYds'),
    'short game uses tactical-target elevation, not full-shot landing terrain')
  assert.ok(worker.includes('shotOrigin: environment.shotOrigin ?? null'),
    'full-shot cache still respects tee-only Driver rule')
  console.log('PASS: 5/60/75yd strategy; 88/95yd full shot; edge + inside bunker; tactical target math; GSPro pin confidence; no full-swing risk or native aim; tee club guard preserved.')
}finally{await vite.close()}
