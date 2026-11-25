import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite=await createServer({appType:'custom',logLevel:'silent',server:{middlewareMode:true}})
try {
  const {isTeeOnlyClub,clubEligibleForShot,resolveShotOriginEligibility}=
    await vite.ssrLoadModule('/src/liveCaddie/clubShotEligibility.ts')
  for (const club of ['Driver','Mini Driver','mini-driver','Mini_Driver']) {
    assert.equal(isTeeOnlyClub(club),true,club)
    assert.equal(clubEligibleForShot(club,'tee'),true)
    assert.equal(clubEligibleForShot(club,'non-tee'),false)
    assert.equal(clubEligibleForShot(club,'unknown'),false)
  }
  for (const club of ['3W','2W','3H','7i','LW']) {
    assert.equal(clubEligibleForShot(club,'non-tee'),true,club)
    assert.equal(clubEligibleForShot(club,'unknown'),true,club)
  }
  assert.equal(resolveShotOriginEligibility('non-tee','tee'),'non-tee',
    'an old tee-colored polygon must never override the live Shot 2 state')
  assert.equal(resolveShotOriginEligibility('unknown','tee'),'unknown')
  assert.equal(resolveShotOriginEligibility(undefined,'tee'),'tee',
    'offline Aim Lab may infer an actual tee from tee geometry')
  const {evaluateAimLab}=await vite.ssrLoadModule('/src/liveCaddie/aimOptimization.ts')
  const {greywolfHole01Geometry}=await vite.ssrLoadModule('/src/courseGeometry/greywolfHole01.ts')
  const now=Date.parse('2026-10-13T13:00:00Z')
  const shots=['Driver','Mini Driver','3W','7i'].flatMap((club,k)=>Array.from({length:11},(_,i)=>({
    id:club+'-'+i,club,included:true,enrichmentStatus:'enriched',source:'simread',
    capturedAt:new Date(now-(i+1)*1000).toISOString(),
    carryYards:[247,228,217,156][k]+((i%3)-1)*4,
    totalYards:[267,250,234,169][k]+((i%3)-1)*4,
    offlineYards:(i%5)-2,
    ballSpeedMph:[147,139,133,113][k],
    launchAngleDeg:[13,13,13,17][k],
    spinRpm:[2700,2900,3500,6000][k],
  })))
  const sessions=[{id:'tee-only-fixture',startedAt:new Date(now-240000).toISOString(),
    endedAt:new Date(now-1000).toISOString(),shots}]
  const hole=greywolfHole01Geometry
  const tee=hole.markers.tee
  const target=[tee[0],tee[1]+230]
  const onTee=evaluateAimLab(sessions,hole,tee,target,{
    shotOrigin:'tee',surfaceOverride:'tee',
  },now)
  assert.ok(onTee.some(x=>x.club==='Driver'), 'Driver should be available on tee with real stock data')
  assert.ok(onTee.some(x=>x.club==='Mini Driver'),'Mini Driver should be available on tee')
  const inDeepRough=evaluateAimLab(sessions,hole,tee,target,{
    shotOrigin:'non-tee',surfaceOverride:'deep-rough',
  },now)
  assert.ok(inDeepRough.length>0,'non-tee still has club recommendations')
  assert.ok(inDeepRough.every(x=>x.club!=='Driver'&&x.club!=='Mini Driver'),
    'NEVER rank either tee-only club off the tee, even near a tee OSM polygon')
  // A fairway wood from deep rough or sand keeps its numbers (the player may arm it) but is never ranked,
  // so it can never be Looper's pick (Brian, 25 Nov).
  const deep3W=inDeepRough.find(x=>x.club==='3W')
  assert.ok(deep3W && deep3W.recommendable===false && deep3W.decisionRank==null,'3W from deep rough: evaluated, not ranked')
  assert.notEqual(inDeepRough[0].club,'3W','3W is never the pick from deep rough')
  const inSand=evaluateAimLab(sessions,hole,tee,target,{shotOrigin:'non-tee',surfaceOverride:'sand'},now)
  assert.ok(inSand[0].club!=='3W' && inSand.find(x=>x.club==='3W')?.decisionRank==null,'3W is never the pick from sand')
  const inRough=evaluateAimLab(sessions,hole,tee,target,{shotOrigin:'non-tee',surfaceOverride:'rough'},now)
  assert.ok(inRough.find(x=>x.club==='3W')?.decisionRank!=null,'regular fairway wood still ranked from rough')
  const {isWoodClub,clubRecommendableFromLie}=await vite.ssrLoadModule('/src/liveCaddie/clubShotEligibility.ts')
  for (const club of ['3W','5W','7W','Driver','Mini Driver','5 wood']) assert.equal(isWoodClub(club),true,club)
  for (const club of ['3H','4i','PW','LW']) assert.equal(isWoodClub(club),false,club)
  assert.equal(clubRecommendableFromLie('5W','TVGsand'),false)
  assert.equal(clubRecommendableFromLie('3H','sand'),true,'hybrids stay allowed')
  assert.equal(clubRecommendableFromLie('3W','fairway'),true)
  const unknown=evaluateAimLab(sessions,hole,tee,target,{
    shotOrigin:'unknown',surfaceOverride:'tee',
  },now)
  assert.ok(unknown.every(x=>x.club!=='Driver'&&x.club!=='Mini Driver'),
    'unknown GSPro shot state is not permission for a tee-only club')
  console.log('PASS: actual full club evaluator excludes Driver+Mini Driver for non-tee/unknown, never ranks woods from sand or deep rough, and keeps the fairway wood elsewhere.')
} finally {await vite.close()}
