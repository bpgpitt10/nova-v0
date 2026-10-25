import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
try {
  const { resolveNativeTeeHudDistance:resolve } =
    await server.ssrLoadModule('/src/courseGeometry/nativeTeeHudDistance.ts')
  const { matchProvisionalOsmTeeByDistance:match } =
    await server.ssrLoadModule('/src/courseGeometry/liveSupportedTee.ts')

  const course = 'FarmLinks at Pursell Farms'
  const aliases = ['FarmLinks', 'FarmLinks at Pursell Farms', 'Pursell Farms', 'farmlinks_al_2_7_gsp']
  const valid = {
    status: 'READY', source: 'gspro-native-shot-hud', courseText: 'Farmlinks Golf Club',
    shotNumber: 1, holeNumber: 1, straightDistanceYds: 492.6,
    scorecardYards: 493, authorizesNativeAim: false,
  }
  const args = { hud: valid, courseName: course, courseAliases: aliases, holeNumber: 1 }
  assert.equal(resolve(args), 492.6, 'Exact screenshot fixture must survive absent currentRound data')
  const geom = {
    registration: { status: 'approximate' },
    markers: { tee: [0, 0], pin: [0, 572] },
    teeCandidates: [
      { teeSet: 'Back', coursePoint: [0, 0], teeToGreenCentroidYards: 572 },
      { teeSet: 'Tee 2', coursePoint: [0, 26], teeToGreenCentroidYards: 546 },
      { teeSet: 'Tee 3', coursePoint: [-37, 78], teeToGreenCentroidYards: 495 },
      { teeSet: 'Tee 4', coursePoint: [-20, 136], teeToGreenCentroidYards: 436 },
    ],
  }
  const mapped = match(geom, resolve(args))
  assert.equal(mapped?.candidate?.teeSet, 'Tee 3', 'Match existing physical OSM pad, not back tee')
  assert.ok(mapped.residualYds < 3)
  const changes = [
    { hud: { ...valid, status: 'UNAVAILABLE' } },
    { hud: { ...valid, source: 'gspro-world-previous-shot' } },
    { hud: { ...valid, authorizesNativeAim: true } },
    { hud: { ...valid, holeNumber: 9 } },
    { hud: { ...valid, shotNumber: 2 } },
    { hud: { ...valid, courseText: 'Shaftesbury Golf Club' } },
    { hud: { ...valid, straightDistanceYds: 472 } },
    { hud: { ...valid, straightDistanceYds: Number.NaN } },
    { hud: { ...valid, scorecardYards: 0 } },
    { holeNumber: 2 },
  ]
  for (const change of changes) {
    assert.equal(resolve({ ...args, ...change }), null, 'Invalid current HUD must fail closed: ' + JSON.stringify(change))
  }
  assert.equal(match({ ...geom, teeCandidates: [
    ...geom.teeCandidates,
    { teeSet:'Ambiguous',coursePoint:[-32,80],teeToGreenCentroidYards:494 },
  ] },492.6),null,'Even good OCR must not promote ambiguous geographic tee')

  console.log('PASS: screenshot Shot 1 492.6yd + matching FarmLinks/H1/493 scorecard independently matches one OSM tee; wrong course/shot/holes and ambiguous pads reject; no native aim.')
} finally { await server.close() }
